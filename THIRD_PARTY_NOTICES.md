# Third-Party Notices

## OpenCode

Git Factory runs the official OpenCode executable, pinned to v1.19.6, commit `f4e363c8295fa90a03dddc451882fffe8fbce357`. Its coding tools and prompt assembly are used through its API, not reimplemented. Runtime archives are downloaded from https://github.com/anomalyco/opencode/releases/tag/v1.19.6 after user consent and checked against pinned SHA-256 digests.

Source: https://github.com/anomalyco/opencode

MIT License

Copyright (c) 2025 opencode

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

OpenCode includes third-party dependencies with their own notices and terms. This notice does not replace upstream dependency notices. MIT permits reuse but still requires retaining the copyright and permission notice in copies or substantial portions.

## Tauri Updater Test Vectors

`src-tauri/examples/verify-update.rs` uses public signature test vectors from tauri-plugin-updater 2.14.1, copyright Tauri Programme within The Commons Conservancy, dual-licensed MIT/Apache-2.0. No production private keys are included.
