import type { AppConfig } from '@mlc-ai/web-llm'
import { LLM_MODEL_ID } from '../config'

// The wasm model library is served from GitHub's raw content CDN, which
// reliably sends permissive CORS headers for public repos — unlike the
// huggingface.co weight download, this one hasn't shown the same
// cross-origin blocking, so it's left pointed directly at the source.
const MODEL_LIB =
  'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm'

const HF_REPO_PATH = 'mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC'

/** Builds WebLLM's model config pointing the weight download at our own
 * origin's /hf-proxy/ route (see worker/index.ts and vite.config.ts's dev
 * proxy) instead of huggingface.co directly. Hugging Face's CDN was
 * observed returning a bare 404 with no CORS headers specifically for
 * cross-origin fetches from this app's domain, while the identical URL
 * loaded fine as a normal page navigation — routing through our own Worker
 * means the request to huggingface.co happens server-side, sidestepping
 * whatever browser-CORS-specific behavior that was. */
export function buildAppConfig(): AppConfig {
  const proxyBase = `${window.location.origin}/hf-proxy/${HF_REPO_PATH}/`
  return {
    model_list: [
      {
        model: proxyBase,
        model_id: LLM_MODEL_ID,
        model_lib: MODEL_LIB,
        low_resource_required: true,
        vram_required_MB: 1629.75,
        overrides: { context_window_size: 4096 },
      },
    ],
  }
}
