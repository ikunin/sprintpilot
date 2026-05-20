# Third-party notices

Sprintpilot is licensed under Apache 2.0 (see `LICENSE` if present, or the `## License` section in `README.md`). It incorporates ideas from third-party projects listed below. Each is reproduced here with its required notices.

---

## GSD (Get Shit Done)

- **Project:** GSD — `gsd-build/get-shit-done`
- **Upstream:** https://github.com/gsd-build/get-shit-done
- **License:** MIT
- **Used by:** `_Sprintpilot/skills/sprintpilot-codebase-map/`

The structure of `sprintpilot-codebase-map` — parallel subagents writing focus-specific analysis documents — is adapted from GSD's `gsd-codebase-mapper` and `/gsd:map-codebase`. Sprintpilot reorganizes that single multi-focus agent into five dedicated agents, renames the output files, and adds BMad Method integration. Agent prompts have been rewritten; output schemas, downstream-consumer tables, and the `scan.js` helper integration are Sprintpilot-original.

### MIT License (GSD)

```
MIT License

Copyright (c) 2025 Lex Christopherson

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
```
