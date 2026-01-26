const SAMPLE_RATE = 24000;

export class PocketTTS {
    constructor(config = {}) {
        this.config = {
            voiceUrl: config.voiceUrl ?? null,
            speed: config.speed ?? 1.0,
            temperature: config.temperature ?? 1.0,
            debug: true // Force logs on
        };

        // --- System State ---
        this.worker = null;
        this.audioContext = null;
        this.isReady = false;

        // --- Processing Queue (Text -> Audio) ---
        this.textQueue = [];       // List of sentences waiting to be synthesized
        this.isGenerating = false; // Is the worker currently busy?
        
        // --- Playback Queue (Audio -> Speakers) ---
        this.audioQueue = [];      // List of { buffer: AudioBuffer, text: string } waiting to play
        this.isPlaying = false;    // Is audio currently coming out of speakers?
        
        // --- Current Job State (Accumulator) ---
        this.currentJobChunks = []; // Raw float arrays from worker

        this.init();
    }

    log(msg, data = '') {
        if (this.config.debug) {
            console.log(`%c[PocketTTS] ${msg}`, 'color: #007bff; font-weight: bold;', data);
        }
    }

    async init() {
        this.log('Initializing System...');
        
        // 1. Setup Audio Context
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: SAMPLE_RATE
        });

        // 2. Setup Single Worker
        this.worker = new Worker('./inference-worker.js', { type: 'module' });
        
        // 3. Setup Listener
        this.worker.onmessage = (e) => this.handleWorkerMessage(e.data);
        
        // 4. Kickstart
        this.worker.postMessage({ type: 'load' });
    }

    /**
     * Entry Point: User calls this to speak text.
     */
    speak(rawText) {
        if (!this.isReady) {
            this.log('⚠️ System not ready yet. Ignoring request.');
            return;
        }

        // 1. Intelligent Segmentation
        const sentences = this.parseText(rawText);
        this.log(`Queued ${sentences.length} new segments.`);

        // 2. Add to Processing Queue
        sentences.forEach(s => this.textQueue.push(s));

        // 3. Start Processing (if idle)
        this.processNextJob();
    }

    /**
     * Core Logic: Sends the next sentence to the worker.
     */
    processNextJob() {
        if (this.isGenerating) return; // Worker is busy
        if (this.textQueue.length === 0) return; // Nothing to do

        this.isGenerating = true;
        const text = this.textQueue.shift();
        this.currentJobChunks = []; // Reset accumulator

        this.log(`Generatng: "${text.substring(0, 20)}..."`);

        // Ensure AudioContext is running (browsers sometimes suspend it)
        if (this.audioContext.state === 'suspended') this.audioContext.resume();

        this.worker.postMessage({
            type: 'generate',
            data: {
                text: text,
                // Voice/Speed/Temp are sent with every request to allow runtime changes
                voice: 'custom', 
                speed: this.config.speed,
                temperature: this.config.temperature
            }
        });
    }

    /**
     * Core Logic: Handles all responses from the worker.
     */
    handleWorkerMessage(msg) {
        const { type, data } = msg;

        switch (type) {
            case 'loaded':
                this.isReady = true;
                this.log('✅ Engine Loaded & Ready');
                if (this.config.voiceUrl) this.loadVoice(this.config.voiceUrl);
                break;

            case 'audio_chunk':
                // Just accumulate raw data. Don't play yet.
                this.currentJobChunks.push(new Float32Array(data));
                break;

            case 'stream_ended':
                // Worker finished one sentence.
                this.finalizeCurrentJob();
                this.isGenerating = false;
                // Immediately try to generate the next one while audio plays
                this.processNextJob();
                break;
                
            case 'voice_encoded':
                this.log('✅ Voice Profile Loaded');
                break;

            default:
                if (msg.status) this.log(`[Worker Status] ${msg.status}`);
        }
    }

    /**
     * Converts raw worker chunks into a playable AudioBuffer.
     */
    finalizeCurrentJob() {
        if (this.currentJobChunks.length === 0) return;

        // 1. Calculate total size
        let totalLen = 0;
        for (const chunk of this.currentJobChunks) totalLen += chunk.length;

        // 2. Merge chunks
        const merged = new Float32Array(totalLen);
        let offset = 0;
        for (const chunk of this.currentJobChunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }

        // 3. Create AudioBuffer
        const buffer = this.audioContext.createBuffer(1, totalLen, SAMPLE_RATE);
        buffer.copyToChannel(merged, 0);

        this.log(`Segment ready (${(totalLen/SAMPLE_RATE).toFixed(2)}s). Added to playback queue.`);

        // 4. Add to Playback Queue and Trigger Playback
        this.audioQueue.push(buffer);
        this.playNextAudio();
    }

    /**
     * Core Logic: Plays audio buffers one by one.
     */
    playNextAudio() {
        if (this.isPlaying) return; // Already playing something
        if (this.audioQueue.length === 0) return; // Silence

        this.isPlaying = true;
        const buffer = this.audioQueue.shift();

        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);

        // Standard "onended" event - extremely reliable
        source.onended = () => {
            this.isPlaying = false;
            // Short pause between sentences for natural prosody
            setTimeout(() => this.playNextAudio(), 250);
        };

        source.start();
    }

    /**
     * Interrupts everything: Clears queues, kills audio, stops worker.
     */
    interrupt() {
        this.log('🛑 Interrupting...');
        
        // 1. Clear Queues
        this.textQueue = [];
        this.audioQueue = [];
        this.currentJobChunks = [];

        // 2. Stop Audio
        // We can't easily stop a specific fire-and-forget node without tracking it,
        // but suspending the context effectively mutes it immediately.
        this.audioContext.suspend().then(() => {
            this.audioContext.resume();
            this.isPlaying = false;
        });

        // 3. Reset Worker
        this.isGenerating = false;
        this.worker.postMessage({ type: 'stop' });
    }

    /**
     * Clear the persisted model cache (CacheStorage + in-memory) used by the worker.
     * Returns a Promise that resolves when the worker confirms cache cleared.
     */
    clearModelCache(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const handler = (e) => {
                const msg = e.data;
                if (msg.type === 'cache_cleared') {
                    this.worker.removeEventListener('message', handler);
                    this.log('✅ Model cache cleared');
                    resolve(msg);
                } else if (msg.type === 'error') {
                    this.worker.removeEventListener('message', handler);
                    reject(new Error(msg.error));
                }
            };
            this.worker.addEventListener('message', handler);
            this.worker.postMessage({ type: 'clear_model_cache' });
            setTimeout(() => {
                this.worker.removeEventListener('message', handler);
                reject(new Error('Timeout clearing model cache'));
            }, timeoutMs);
        });
    }

    /**
     * Advanced Parser from your requirements
     */
    parseText(rawText) {
        let text = rawText
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();

        const uuid = "UUID_DOT";
        const abbrevs = ["Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "St.", "vs.", "etc."];
        
        // Protect abbreviations
        abbrevs.forEach(abbr => {
            const protectedAbbr = abbr.replace('.', uuid);
            text = text.split(" " + abbr).join(" " + protectedAbbr);
        });
        
        // Protect decimals
        text = text.replace(/(\d+)\.(\s)/g, `$1${uuid}$2`);

        // Split by punctuation
        const regex = /([.!?]+["')\]]*)/g;
        const parts = text.split(regex);
        
        let sentences = [];
        let current = "";

        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (!p) continue;
            current += p;
            if (regex.test(p)) { // If this part is punctuation
                sentences.push(current.trim());
                current = "";
            }
        }
        if (current.trim()) sentences.push(current.trim());

        // Restore dots and length filter
        return sentences
            .map(s => s.split(uuid).join('.'))
            .filter(s => s.length > 0);
    }

    async loadVoice(url) {
        try {
            this.log(`Loading voice: ${url}`);
            const resp = await fetch(url);
            const arrayBuf = await resp.arrayBuffer();
            const audioBuf = await this.audioContext.decodeAudioData(arrayBuf);
            
            // Mono mix & Resample
            let data = this.resampleTo24kMono(audioBuf);
            
            // Limit to 10s
            if (data.length > 24000 * 10) {
                data = data.slice(0, 24000 * 10);
            }

            this.worker.postMessage({ 
                type: 'encode_voice', 
                data: { audio: data } 
            });
        } catch (e) {
            console.error(e);
            this.log('❌ Failed to load voice');
        }
    }

    resampleTo24kMono(audioBuffer) {
        const sourceRate = audioBuffer.sampleRate;
        const targetRate = 24000;
        
        // 1. Mix to Mono
        let mono = audioBuffer.getChannelData(0);
        if (audioBuffer.numberOfChannels > 1) {
            const ch2 = audioBuffer.getChannelData(1);
            const temp = new Float32Array(mono.length);
            for(let i=0; i<mono.length; i++) temp[i] = (mono[i] + ch2[i]) / 2;
            mono = temp;
        }

        if (sourceRate === targetRate) return mono;

        // 2. Linear Interpolation Resample
        const ratio = sourceRate / targetRate;
        const newLength = Math.round(mono.length / ratio);
        const result = new Float32Array(newLength);

        for (let i = 0; i < newLength; i++) {
            const srcIdx = i * ratio;
            const idx = Math.floor(srcIdx);
            const t = srcIdx - idx;
            const s0 = mono[idx] || 0;
            const s1 = mono[idx + 1] || 0;
            result[i] = s0 * (1 - t) + s1 * t;
        }
        return result;
    }
}

// Global Hook
window.initTTS = (config) => {
    window.tts = new PocketTTS(config);
    window.speak = (text) => window.tts.speak(text);
    window.interrupt = () => window.tts.interrupt();
};