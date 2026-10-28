# Notices and Attribution

## Relationship to qq-bridge

QQ Agent Framework is an independent TypeScript rebuild informed by the requirements, interfaces, operational lessons, and failure modes of the open source project [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge). This attribution does not imply a runtime dependency on that project.

This repository is not an official release, successor, or Git fork of qq-bridge, and it is not endorsed by the qq-bridge authors. It does not claim that the referenced design and operational work is wholly original to this repository. Where qq-bridge material is adapted or redistributed, the following upstream copyright and MIT license apply.

The group conversation redesign reviewed on 2026-10-28 references qq-bridge revision `bdc6d09`: explicit send behavior in `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`, unread wake coalescing and recent participation cues in `src/bridge.js`, and continuation handling in `src/local/dialogue-wake.js`. This framework implements those ideas through its own typed inbox, policy and output services. Its continuation window includes all group members, and its queue preserves the actual executing sender separately from wake metadata.

## qq-bridge MIT License

MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The upstream `LICENSE` file also contains project-specific third-party and compliance notes after this MIT text. Those notes describe the upstream dependency set and are not reproduced as terms for this independent repository; consult the [upstream LICENSE](https://github.com/Derpyu520/qq-bridge/blob/main/LICENSE) when using or redistributing qq-bridge itself.

## This Repository

### Built-in Markdown Image Rendering

The framework's Markdown-to-PNG integration uses [markdown-it](https://github.com/markdown-it/markdown-it) for parsing, [Takumi](https://github.com/kane50613/takumi) for local layout and image rendering, [highlight.js](https://github.com/highlightjs/highlight.js) for static syntax highlighting, [MathJax](https://github.com/mathjax/MathJax) for local mathematical notation, and [sharp](https://github.com/lovell/sharp) for PNG pagination. These packages retain their respective licenses and notices in their distributions. No headless browser is bundled by this integration.

[mdshot](https://github.com/pi0/mdshot) was reviewed as a Markdown screenshot reference during engine selection; its source is not embedded in this implementation. Bundled Chinese font attribution and redistribution terms are listed separately below.

### Video Observation

The built-in video observer invokes a separately installed [FFmpeg/FFprobe](https://github.com/FFmpeg/FFmpeg) executable. It uses the documented probe metadata and frame extraction interfaces. FFmpeg source and binaries are not embedded or redistributed by this integration. An installed FFmpeg distribution retains its own license, which depends on its build options; consult its accompanying notices and [upstream license](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md).

### Bundled WenQuanYi Micro Hei Font

The Markdown image renderer uses the unmodified WenQuanYi Micro Hei 0.2.0-beta font collection, redistributed under Apache License 2.0 as identified by the font's embedded license records. Digitized data copyright © 2007 Google Corporation; copyright © 2008–2009 WenQuanYi Board of Trustees and Qianqian Fang. The collection includes WenQuanYi Micro Hei and WenQuanYi Micro Hei Mono.

The font, complete license, original authors and upstream notice are bundled in [assets/fonts](assets/fonts/README.md). This font remains subject to its separate license; the framework's MIT license does not replace it.

### OneBot QQ Space Interface References

The shared QQ Space adapter is independently implemented against the wire interfaces documented by these projects; it does not embed their clients or web authentication implementations:

- [OneBot v11 standard API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md): QQ Space actions are outside this standard.
- [NapCat publish action](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/extends/SendQzoneMsg.ts) and [delete action](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/extends/DeleteQzoneMsg.ts).
- [NapCat v4.18.14 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.14): introduction of publishing, image upload and deletion.
- SnowLuma [publish reference](https://snowluma.github.io/zh/docs/api/qzone/send_qzone_msg), [delete reference](https://snowluma.github.io/zh/docs/api/qzone/delete_qzone_msg), and [action definitions](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/actions/qzone.ts).

References reviewed on 2026-10-27. Installed gateway versions and enabled extensions determine actual availability.

### Provider Model Metadata References

The provider metadata reader uses the declared fields described in the [DeepSeek model catalog](https://api-docs.deepseek.com/api/list-models/) and the [Chat Completions reasoning parameter](https://api-docs.deepseek.com/api/create-chat-completion/). Reviewed on 2026-10-28. The `off` to `none` mapping implied by that documentation is restricted to the official DeepSeek OpenAI-compatible endpoint; other providers must explicitly declare their mapping.

QQ Agent Framework's own source is distributed under the MIT license in [LICENSE](LICENSE). Dependencies and separately obtained protocol gateways, agent runtimes, models, or services remain subject to their own licenses and terms. This notice does not grant rights to third-party software and does not imply affiliation with Tencent, QQ, DeepSeek, SnowLuma, or the qq-bridge authors.
