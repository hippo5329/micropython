/*
 * This file is part of the MicroPython project, http://micropython.org/
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2023-2024 Damien P. George
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

// Options:
// - heapsize: size in bytes of the MicroPython GC heap.
// - url: location to load `micropython.mjs`.
// - stdin: function to return input characters.
// - stdout: function that takes one argument, and is passed lines of stdout
//   output as they are produced.  By default this is handled by Emscripten
//   and in a browser goes to console, in node goes to process.stdout.write.
// - stderr: same behaviour as stdout but for error output.
// - linebuffer: whether to buffer line-by-line to stdout/stderr.
export async function loadMicroPython(options) {
    const { heapsize, url, stdin, stdout, stderr, linebuffer } = Object.assign(
        { heapsize: 1024 * 1024, linebuffer: true },
        options,
    );
    const Module = {};
    Module.locateFile = (path, scriptDirectory) =>
        url || scriptDirectory + path;
    Module._textDecoder = new TextDecoder();
    if (stdin !== undefined) {
        Module.stdin = stdin;
    }
    if (stdout !== undefined) {
        if (linebuffer) {
            Module._stdoutBuffer = [];
            Module.stdout = (c) => {
                if (c === 10) {
                    stdout(
                        Module._textDecoder.decode(
                            new Uint8Array(Module._stdoutBuffer),
                        ),
                    );
                    Module._stdoutBuffer = [];
                } else {
                    Module._stdoutBuffer.push(c);
                }
            };
        } else {
            Module.stdout = (c) => stdout(new Uint8Array([c]));
        }
    }
    if (stderr !== undefined) {
        if (linebuffer) {
            Module._stderrBuffer = [];
            Module.stderr = (c) => {
                if (c === 10) {
                    stderr(
                        Module._textDecoder.decode(
                            new Uint8Array(Module._stderrBuffer),
                        ),
                    );
                    Module._stderrBuffer = [];
                } else {
                    Module._stderrBuffer.push(c);
                }
            };
        } else {
            Module.stderr = (c) => stderr(new Uint8Array([c]));
        }
    }
    const moduleLoaded = new Promise((r) => {
        Module.postRun = r;
    });
    _createMicroPythonModule(Module);
    await moduleLoaded;
    globalThis.Module = Module;
    proxy_js_init();
    const pyimport = (name) => {
        const value = Module._malloc(3 * 4);
        Module.ccall(
            "mp_js_do_import",
            "null",
            ["string", "pointer"],
            [name, value],
        );
        return proxy_convert_mp_to_js_obj_jsside_with_free(value);
    };
    Module.ccall("mp_js_init", "null", ["number"], [heapsize]);
    Module.ccall("proxy_c_init", "null", [], []);
    return {
        _module: Module,
        PyProxy: PyProxy,
        FS: Module.FS,
        globals: {
            __dict__: pyimport("__main__").__dict__,
            get(key) {
                return this.__dict__[key];
            },
            set(key, value) {
                this.__dict__[key] = value;
            },
            delete(key) {
                delete this.__dict__[key];
            },
        },
        registerJsModule(name, module) {
            const value = Module._malloc(3 * 4);
            proxy_convert_js_to_mp_obj_jsside(module, value);
            Module.ccall(
                "mp_js_register_js_module",
                "null",
                ["string", "pointer"],
                [name, value],
            );
            Module._free(value);
        },
        pyimport: pyimport,
        runPython(code) {
            const value = Module._malloc(3 * 4);
            Module.ccall(
                "mp_js_do_exec",
                "number",
                ["string", "pointer"],
                [code, value],
            );
            return proxy_convert_mp_to_js_obj_jsside_with_free(value);
        },
        runPythonAsync(code) {
            const value = Module._malloc(3 * 4);
            Module.ccall(
                "mp_js_do_exec_async",
                "number",
                ["string", "pointer"],
                [code, value],
            );
            return proxy_convert_mp_to_js_obj_jsside_with_free(value);
        },
    };
}

globalThis.loadMicroPython = loadMicroPython;

async function runCLI() {
    const fs = await import("fs");
    let heap_size = 128 * 1024;
    let contents = "";
    let repl = true;

    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === "-X" && i < process.argv.length - 1) {
            if (process.argv[i + 1].includes("heapsize=")) {
                heap_size = parseInt(process.argv[i + 1].split("heapsize=")[1]);
                const suffix = process.argv[i + 1].substr(-1).toLowerCase();
                if (suffix === "k") {
                    heap_size *= 1024;
                } else if (suffix === "m") {
                    heap_size *= 1024 * 1024;
                }
                ++i;
            }
        } else {
            contents += fs.readFileSync(process.argv[i], "utf8");
            repl = false;
        }
    }

    if (process.stdin.isTTY === false) {
        contents = fs.readFileSync(0, "utf8");
        repl = false;
    }

    const mp = await loadMicroPython({
        heapsize: heap_size,
        stdout: (data) => process.stdout.write(data),
        linebuffer: false,
    });

    if (repl) {
        mp_js_init_repl();
        process.stdin.setRawMode(true);
        process.stdin.on("data", (data) => {
            for (let i = 0; i < data.length; i++) {
                mp_js_process_char(data[i]).then((result) => {
                    if (result) {
                        process.exit();
                    }
                });
            }
        });
    } else {
        try {
            mp.runPython(contents);
        } catch (error) {
            if (error.name === "PythonError") {
                if (error.type === "SystemExit") {
                    // SystemExit, this is a valid exception to successfully end a script.
                } else {
                    // An unhandled Python exception, print in out.
                    console.error(error.message);
                }
            } else {
                // A non-Python exception.  Re-raise it.
                throw error;
            }
        }
    }
}

// Check if Node is running (equivalent to ENVIRONMENT_IS_NODE).
if (
    typeof process === "object" &&
    typeof process.versions === "object" &&
    typeof process.versions.node === "string"
) {
    // Check if this module is ron from the command line.
    //
    // See https://stackoverflow.com/questions/6398196/detect-if-called-through-require-or-directly-by-command-line/66309132#66309132
    //
    // Note:
    // - `resolve()` is used to handle symlinks
    // - `includes()` is used to handle cases where the file extension was omitted when passed to node

    const path = await import("path");
    const url = await import("url");

    const pathToThisFile = path.resolve(url.fileURLToPath(import.meta.url));
    const pathPassedToNode = path.resolve(process.argv[1]);
    const isThisFileBeingRunViaCLI = pathToThisFile.includes(pathPassedToNode);

    if (isThisFileBeingRunViaCLI) {
        runCLI();
    }
}