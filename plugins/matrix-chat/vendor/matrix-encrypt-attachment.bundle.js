var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/matrix-encrypt-attachment/lib/browser-encrypt-attachment.js
var require_browser_encrypt_attachment = __commonJS({
  "node_modules/matrix-encrypt-attachment/lib/browser-encrypt-attachment.js"(exports, module) {
    (function(f) {
      if (typeof exports === "object" && typeof module !== "undefined") {
        module.exports = f();
      } else if (typeof define === "function" && define.amd) {
        define([], f);
      } else {
        var g;
        if (typeof window !== "undefined") {
          g = window;
        } else if (typeof global !== "undefined") {
          g = global;
        } else if (typeof self !== "undefined") {
          g = self;
        } else {
          g = this;
        }
        g.MatrixEncryptAttachment = f();
      }
    })(function() {
      var define2, module2, exports2;
      return (/* @__PURE__ */ (function() {
        function r(e, n, t) {
          function o(i2, f) {
            if (!n[i2]) {
              if (!e[i2]) {
                var c = "function" == typeof __require && __require;
                if (!f && c) return c(i2, true);
                if (u) return u(i2, true);
                var a = new Error("Cannot find module '" + i2 + "'");
                throw a.code = "MODULE_NOT_FOUND", a;
              }
              var p = n[i2] = { exports: {} };
              e[i2][0].call(p.exports, function(r2) {
                var n2 = e[i2][1][r2];
                return o(n2 || r2);
              }, p, p.exports, r, e, n, t);
            }
            return n[i2].exports;
          }
          for (var u = "function" == typeof __require && __require, i = 0; i < t.length; i++) o(t[i]);
          return o;
        }
        return r;
      })())({ 1: [function(require2, module3, exports3) {
        "use strict";
        var __awaiter = this && this.__awaiter || function(thisArg, _arguments, P, generator) {
          function adopt(value) {
            return value instanceof P ? value : new P(function(resolve) {
              resolve(value);
            });
          }
          return new (P || (P = Promise))(function(resolve, reject) {
            function fulfilled(value) {
              try {
                step(generator.next(value));
              } catch (e) {
                reject(e);
              }
            }
            function rejected(value) {
              try {
                step(generator["throw"](value));
              } catch (e) {
                reject(e);
              }
            }
            function step(result) {
              result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
            }
            step((generator = generator.apply(thisArg, _arguments || [])).next());
          });
        };
        var __generator = this && this.__generator || function(thisArg, body) {
          var _ = { label: 0, sent: function() {
            if (t[0] & 1) throw t[1];
            return t[1];
          }, trys: [], ops: [] }, f, y, t, g;
          return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
            return this;
          }), g;
          function verb(n) {
            return function(v) {
              return step([n, v]);
            };
          }
          function step(op) {
            if (f) throw new TypeError("Generator is already executing.");
            while (_) try {
              if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
              if (y = 0, t) op = [op[0] & 2, t.value];
              switch (op[0]) {
                case 0:
                case 1:
                  t = op;
                  break;
                case 4:
                  _.label++;
                  return { value: op[1], done: false };
                case 5:
                  _.label++;
                  y = op[1];
                  op = [0];
                  continue;
                case 7:
                  op = _.ops.pop();
                  _.trys.pop();
                  continue;
                default:
                  if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
                    _ = 0;
                    continue;
                  }
                  if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
                    _.label = op[1];
                    break;
                  }
                  if (op[0] === 6 && _.label < t[1]) {
                    _.label = t[1];
                    t = op;
                    break;
                  }
                  if (t && _.label < t[2]) {
                    _.label = t[2];
                    _.ops.push(op);
                    break;
                  }
                  if (t[2]) _.ops.pop();
                  _.trys.pop();
                  continue;
              }
              op = body.call(thisArg, _);
            } catch (e) {
              op = [6, e];
              y = 0;
            } finally {
              f = t = 0;
            }
            if (op[0] & 5) throw op[1];
            return { value: op[0] ? op[1] : void 0, done: true };
          }
        };
        Object.defineProperty(exports3, "__esModule", { value: true });
        exports3.decodeBase64 = exports3.encodeBase64 = exports3.decryptAttachment = exports3.encryptAttachment = void 0;
        function encryptAttachment2(plaintextBuffer) {
          return __awaiter(this, void 0, void 0, function() {
            var ivArray, cryptoKey, exportedKey, ciphertextBuffer, sha256Buffer;
            return __generator(this, function(_a) {
              switch (_a.label) {
                case 0:
                  ivArray = new Uint8Array(16);
                  window.crypto.getRandomValues(ivArray.subarray(0, 8));
                  return [4, window.crypto.subtle.generateKey({ "name": "AES-CTR", "length": 256 }, true, ["encrypt", "decrypt"])];
                case 1:
                  cryptoKey = _a.sent();
                  return [4, window.crypto.subtle.exportKey("jwk", cryptoKey)];
                case 2:
                  exportedKey = _a.sent();
                  return [4, window.crypto.subtle.encrypt({ name: "AES-CTR", counter: ivArray, length: 64 }, cryptoKey, plaintextBuffer)];
                case 3:
                  ciphertextBuffer = _a.sent();
                  return [4, window.crypto.subtle.digest("SHA-256", ciphertextBuffer)];
                case 4:
                  sha256Buffer = _a.sent();
                  return [2, {
                    data: ciphertextBuffer,
                    info: {
                      v: "v2",
                      key: exportedKey,
                      iv: encodeBase64(ivArray),
                      hashes: {
                        sha256: encodeBase64(new Uint8Array(sha256Buffer))
                      }
                    }
                  }];
              }
            });
          });
        }
        exports3.encryptAttachment = encryptAttachment2;
        function decryptAttachment2(ciphertextBuffer, info) {
          return __awaiter(this, void 0, void 0, function() {
            var ivArray, expectedSha256base64, cryptoKey, digestResult, counterLength;
            return __generator(this, function(_a) {
              switch (_a.label) {
                case 0:
                  if (info === void 0 || info.key === void 0 || info.iv === void 0 || info.hashes === void 0 || info.hashes.sha256 === void 0) {
                    throw new Error("Invalid info. Missing info.key, info.iv or info.hashes.sha256 key");
                  }
                  if (info.v && !info.v.match(/^v[1-2]$/)) {
                    throw new Error("Unsupported protocol version: " + info.v);
                  }
                  ivArray = decodeBase64(info.iv);
                  expectedSha256base64 = info.hashes.sha256;
                  return [4, window.crypto.subtle.importKey("jwk", info.key, { "name": "AES-CTR" }, false, ["encrypt", "decrypt"])];
                case 1:
                  cryptoKey = _a.sent();
                  return [4, window.crypto.subtle.digest("SHA-256", ciphertextBuffer)];
                case 2:
                  digestResult = _a.sent();
                  if (encodeBase64(new Uint8Array(digestResult)) != expectedSha256base64) {
                    throw new Error("Mismatched SHA-256 digest");
                  }
                  if (info.v == "v1" || info.v == "v2") {
                    counterLength = 64;
                  } else {
                    counterLength = 128;
                  }
                  return [2, window.crypto.subtle.decrypt({ name: "AES-CTR", counter: ivArray, length: counterLength }, cryptoKey, ciphertextBuffer)];
              }
            });
          });
        }
        exports3.decryptAttachment = decryptAttachment2;
        function encodeBase64(uint8Array) {
          var latin1String = String.fromCharCode.apply(null, uint8Array);
          var paddedBase64 = window.btoa(latin1String);
          var inputLength = uint8Array.length;
          var outputLength = 4 * Math.floor((inputLength + 2) / 3) + (inputLength + 2) % 3 - 2;
          return paddedBase64.slice(0, outputLength);
        }
        exports3.encodeBase64 = encodeBase64;
        function decodeBase64(base64) {
          var paddedBase64 = base64 + "===".slice(0, (4 - base64.length % 4) % 4);
          var latin1String = window.atob(paddedBase64);
          var uint8Array = new Uint8Array(latin1String.length);
          for (var i = 0; i < latin1String.length; i++) {
            uint8Array[i] = latin1String.charCodeAt(i);
          }
          return uint8Array;
        }
        exports3.decodeBase64 = decodeBase64;
        exports3.default = {
          encryptAttachment: encryptAttachment2,
          decryptAttachment: decryptAttachment2,
          encodeBase64,
          decodeBase64
        };
      }, {}] }, {}, [1])(1);
    });
  }
});

// attachment-entry.js
var import_matrix_encrypt_attachment = __toESM(require_browser_encrypt_attachment());
var export_decryptAttachment = import_matrix_encrypt_attachment.decryptAttachment;
var export_encryptAttachment = import_matrix_encrypt_attachment.encryptAttachment;
export {
  export_decryptAttachment as decryptAttachment,
  export_encryptAttachment as encryptAttachment
};
