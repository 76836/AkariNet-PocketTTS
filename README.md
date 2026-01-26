Pocket TTS (web)

Changes:
- ONNX model files are now sourced from Hugging Face: `KevinAHM/pocket-tts-onnx` (the `onnx/` folder)
- Smart model caching added: models are cached in the browser Cache Storage (and in-memory) to avoid repeated downloads

Developer notes:
- The worker (`inference-worker.js`) will fetch models from:
  `https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx/<model>.onnx`
  If network fetch fails, it will fall back to the local `./onnx/<model>.onnx` file if present.
- To clear the model cache programmatically, call `PocketTTS.clearModelCache()` from your page; the worker also supports `{ type: 'clear_model_cache' }` messages.

Security & CORS:
- The Hugging Face raw URLs should be publicly accessible; ensure your hosting environment allows cross-origin fetches if embedding the demo.

If you want a different source (e.g., self-hosted CDN), update the `HF_ONNX_BASE` constant in `inference-worker.js` to point to your base URL.