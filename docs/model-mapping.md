# catalog ↔ live 模型映射表

> 由 `scripts/build-mapping.ts` 生成。live 侧为某个 `sk-` key 的 `GET /v1/models`（可用性随 key 分组变化）。

- live 模型总数（含 chat）：**295**
- catalog 生成模型数：**117**
- 精确匹配（可直接调用）：**32**
- family 近似匹配（变体命名待核实）：**17**
- catalog 有但当前 key 未开通：**85**

## 精确匹配（live id == catalog model，可直接用）

| live / catalog model | media | spec 文件 |
|---|---|---|
| `cohere-transcribe` | audio | cohere-transcribe.json |
| `doc2x-v3` | document | doc2x-v3.json |
| `gemini-3-pro-image-preview` | image | gemini-3-pro-image-preview.json |
| `gemini-3.1-flash-image-preview` | image | gemini-3.1-flash-image-preview.json |
| `gpt-4o-image` | image | gpt-4o-image-generation.json |
| `gpt-image-1` | image | gpt-image-1-image-generation.json |
| `gpt-image-1.5` | image | gpt-image-1.5-image-generation.json |
| `gpt-image-2` | image | gpt-image-2.json |
| `kling-o3-image-to-video` | video | kling-o3-image-to-video.json |
| `kling-o3-reference-to-video` | video | kling-o3-reference-to-video.json |
| `kling-o3-text-to-video` | video | kling-o3-text-to-video.json |
| `kling-o3-video-to-video-edit` | video | kling-o3-video-to-video-edit.json |
| `kling-o3-video-to-video-reference` | video | kling-o3-video-to-video-reference.json |
| `kling-v2-6-video` | video | kling-v2-6-video.json |
| `kling-v3-image-to-video` | video | kling-v3-image-to-video.json |
| `kling-v3-motion-control` | video | kling-v3-motion-control.json |
| `kling-v3-text-to-video` | video | kling-v3-text-to-video.json |
| `lipsync-2` | video | lipsync-2.json |
| `lyria-3` | audio | lyria.json |
| `minimax-music-v2.6` | audio | minimax-music.json |
| `omnihuman-1.5` | video | omnihuman-1.5.json |
| `paraformer-v2` | audio | paraformer-v2.json |
| `sora-2` | video | sora-2.json |
| `sora-2-pro` | video | sora2pro-video-generate.json |
| `speech-2.8-hd` | audio | speech-2.8.json |
| `topaz-upscale-video` | video | topaz-upscale-video.json |
| `veo-3.1` | video | veo-3.1.json |
| `veo-3.1-extend` | video | veo-3.1-extend.json |
| `veo-3.1-first-last-frame-to-video` | video | veo-3.1-first-last-frame-to-video.json |
| `veo-3.1-image-to-video` | video | veo-3.1-image-to-video.json |
| `veo-3.1-reference-to-video` | video | veo-3.1-reference-to-video.json |
| `veo-3.1-text-to-video` | video | veo-3.1-text-to-video.json |

## family 近似匹配（需与网关侧核对变体参数映射）

| live id | 归一化 family | catalog 文件 | 备注 |
|---|---|---|---|
| `fabric-1.0-text[480p]` | `fabric-1.0-text` | fabric-1.0-text.json | 归一化到 catalog family "fabric-1.0-text"，变体 [480p] 的参数映射需与网关侧核对 |
| `fabric-1.0-text[720p]` | `fabric-1.0-text` | fabric-1.0-text.json | 归一化到 catalog family "fabric-1.0-text"，变体 [720p] 的参数映射需与网关侧核对 |
| `fabric-1.0[480p]` | `fabric-1.0` | fabric-1.0.json | 归一化到 catalog family "fabric-1.0"，变体 [480p] 的参数映射需与网关侧核对 |
| `fabric-1.0[720p]` | `fabric-1.0` | fabric-1.0.json | 归一化到 catalog family "fabric-1.0"，变体 [720p] 的参数映射需与网关侧核对 |
| `google/veo-3.1` | `veo-3.1` | veo-3.1.json | 归一化到 catalog family "veo-3.1" |
| `google/veo-3.1[audio]` | `veo-3.1` | veo-3.1.json | 归一化到 catalog family "veo-3.1"，变体 [audio] 的参数映射需与网关侧核对 |
| `google/veo-3.1[fast]` | `veo-3.1` | veo-3.1.json | 归一化到 catalog family "veo-3.1"，变体 [fast] 的参数映射需与网关侧核对 |
| `google/veo-3.1[fast|audio]` | `veo-3.1` | veo-3.1.json | 归一化到 catalog family "veo-3.1"，变体 [fast|audio] 的参数映射需与网关侧核对 |
| `google/veo-3.1[reference-to-video]` | `veo-3.1` | veo-3.1.json | 归一化到 catalog family "veo-3.1"，变体 [reference-to-video] 的参数映射需与网关侧核对 |
| `google/veo-3.1[reference-to-video|audio]` | `veo-3.1` | veo-3.1.json | 归一化到 catalog family "veo-3.1"，变体 [reference-to-video|audio] 的参数映射需与网关侧核对 |
| `kling-v3-motion-control[pro]` | `kling-v3-motion-control` | kling-v3-motion-control.json | 归一化到 catalog family "kling-v3-motion-control"，变体 [pro] 的参数映射需与网关侧核对 |
| `openai/sora-2` | `sora-2` | sora-2.json | 归一化到 catalog family "sora-2" |
| `openai/sora-2-pro` | `sora-2-pro` | sora2pro-video-generate.json | 归一化到 catalog family "sora-2-pro" |
| `veo-3.1-extend[audio]` | `veo-3.1-extend` | veo-3.1-extend.json | 归一化到 catalog family "veo-3.1-extend"，变体 [audio] 的参数映射需与网关侧核对 |
| `veo-3.1[4k]` | `veo-3.1` | veo-3.1.json | 归一化到 catalog family "veo-3.1"，变体 [4k] 的参数映射需与网关侧核对 |
| `veo-3.1[4k|audio]` | `veo-3.1` | veo-3.1.json | 归一化到 catalog family "veo-3.1"，变体 [4k|audio] 的参数映射需与网关侧核对 |
| `veo-3.1[audio]` | `veo-3.1` | veo-3.1.json | 归一化到 catalog family "veo-3.1"，变体 [audio] 的参数映射需与网关侧核对 |

## catalog 有、当前 key 未开通（文档可见但不可调用）

| catalog model | media | spec 文件 |
|---|---|---|
| `creatify-aurora` | video | creatify-aurora.json |
| `fabric-1.0-text` | video | fabric-1.0-text.json |
| `fabric-1.0` | video | fabric-1.0.json |
| `gemini-3.1-flash-image-preview-dev` | image | gemini-3.1-flash-image-preview-dev.json |
| `gemini-3.1-flash-tts` | audio | gemini-3.1-flash-tts.json |
| `gpt-image-1.5-lite` | image | gpt-image-1.5-lite-image-generation.json |
| `grok-imagine-edit-video` | video | grok-imagine-edit-video.json |
| `grok-imagine-image-to-video` | video | grok-imagine-image-to-video.json |
| `grok-imagine-image` | image | grok-imagine-image.json |
| `grok-imagine-reference-to-video` | video | grok-imagine-reference-to-video.json |
| `grok-imagine-text-to-video` | video | grok-imagine-text-to-video.json |
| `grok-imagine-video-extension` | video | grok-imagine-video-extension.json |
| `MiniMax-Hailuo-02` | video | hailuo-02-video-generate.json |
| `MiniMax-Hailuo-2.3-Fast` | video | hailuo-2-3-fast-video-generate.json |
| `MiniMax-Hailuo-2.3` | video | hailuo-2-3-video-generate.json |
| `happyhorse-1.0-image-to-video` | video | happyhorse-1.0-image-to-video.json |
| `happyhorse-1.0-reference-to-video` | video | happyhorse-1.0-reference-to-video.json |
| `happyhorse-1.0-text-to-video` | video | happyhorse-1.0-text-to-video.json |
| `happyhorse-1.0-video-edit` | video | happyhorse-1.0-video-edit.json |
| `heygen-video-agent` | video | heygen-video-agent.json |
| `kling-custom-element` | video | kling-custom-element.json |
| `kling-o1-i2v` | video | kling-o1-image-to-video.json |
| `kling-o1-edit-fast` | video | kling-o1-video-edit-fast.json |
| `kling-o1-edit` | video | kling-o1-video-edit.json |
| `kling-o3-edit` | video | kling-o3-video-edit.json |
| `kling-video-create-voice` | video | kling-video-create-voice.json |
| `live-avatar` | video | live-avatar.json |
| `minimax-voice-clone` | audio | minimax-voice-clone.json |
| `nanobanana` | image | nanobanana-image-generate.json |
| `nanobanana-pro-beta` | image | nanobanana-pro-beta-image-generate.json |
| `nano-banana-2-beta` | image | nanobanana2-beta-image-generate.json |
| `patina-material-extract` | image | patina-material-extract.json |
| `patina-material` | image | patina-material.json |
| `patina-pbr-maps` | image | patina-pbr-maps.json |
| `phota-create-profile` | image | phota-create-profile.json |
| `phota-image-edit` | image | phota-image-edit.json |
| `phota-image-enhance` | image | phota-image-enhance.json |
| `phota-image` | image | phota-image.json |
| `pixverse-c1-image-to-video` | video | pixverse-c1-image-to-video.json |
| `pixverse-c1-reference-to-video` | video | pixverse-c1-reference-to-video.json |
| `pixverse-c1-text-to-video` | video | pixverse-c1-text-to-video.json |
| `pixverse-c1-transition` | video | pixverse-c1-transition.json |
| `pixverse-v6-extend` | video | pixverse-v6-extend.json |
| `pixverse-v6-image-to-video` | video | pixverse-v6-image-to-video.json |
| `pixverse-v6-text-to-video` | video | pixverse-v6-text-to-video.json |
| `pixverse-v6-transition` | video | pixverse-v6-transition.json |
| `qwen-image-edit-plus` | image | qwen-image-edit-plus.json |
| `qwen-image-edit` | image | qwen-image-edit.json |
| `scribe-v2` | audio | scribe-v2.json |
| `seedance-1.0-pro-fast` | video | seedance-1.0-pro-fast-video-generate.json |
| `seedance-1.5-pro` | video | seedance-1.5-pro-video-generate.json |
| `seedance-2.0-image-to-video` | video | seedance-2.0-image-to-video.json |
| `seedance-2.0-reference-to-video` | video | seedance-2.0-reference-to-video.json |
| `seedance-2.0-text-to-video` | video | seedance-2.0-text-to-video.json |
| `doubao-seedream-4.0` | image | seedream-4.0-image-generate.json |
| `doubao-seedream-4.5` | image | seedream-4.5-image-generate.json |
| `doubao-seedream-5.0-lite` | image | seedream-5.0-lite-image-generate.json |
| `sora-2-beta-max` | video | sora-2-beta-max-video-generate.json |
| `sora-2-character` | video | sora-2-character.json |
| `sora-2-pro-remix` | video | sora-2-pro-remix.json |
| `suno-v4` | audio | suno-music-generation.json |
| `veed-subtitles` | video | veed-subtitles.json |
| `veo3.1-fast-lite` | video | veo3.1-fast-video-generate.json |
| `veo3.1-pro-lite` | video | veo3.1-pro-video-generate.json |
| `vidu-q3-image-to-video` | video | vidu-q3-image-to-video.json |
| `vidu-q3-reference-to-video` | video | vidu-q3-reference-to-video.json |
| `vidu-q3-text-to-video` | video | vidu-q3-text-to-video.json |
| `vidu-q3-turbo-image-to-video` | video | vidu-q3-turbo-image-to-video.json |
| `vidu-q3-turbo-text-to-video` | video | vidu-q3-turbo-text-to-video.json |
| `voice-clone` | audio | voice-clone.json |
| `wan-2.7-image-to-video` | video | wan-2.7-image-to-video.json |
| `wan-2.7-image` | image | wan-2.7-image.json |
| `wan-2.7-reference-to-video` | video | wan-2.7-reference-to-video.json |
| `wan-2.7-text-to-video` | video | wan-2.7-text-to-video.json |
| `wan-2.7-video-edit` | video | wan-2.7-video-edit.json |
| `wan2.5-image-to-image` | image | wan2.5-image-to-image.json |
| `wan2.5-i2v` | video | wan2.5-image-to-video.json |
| `wan2.5-text-to-image` | image | wan2.5-text-to-image.json |
| `wan2.5-t2v` | video | wan2.5-text-to-video.json |
| `wan2.6-i2v-flash` | video | wan2.6-image-to-video-flash.json |
| `wan2.6-i2v` | video | wan2.6-image-to-video.json |
| `wan2.6-ref-flash` | video | wan2.6-reference-video-flash.json |
| `wan2.6-ref` | video | wan2.6-reference-video.json |
| `wan2.6-t2v` | video | wan2.6-text-to-video.json |
| `z-image-turbo` | image | z-image-turbo-image-generate.json |
