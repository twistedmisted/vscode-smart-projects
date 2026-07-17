"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
function detectProjectLanguage(dir) {
    try {
        const files = fs.readdirSync(dir);
        if (files.includes("pom.xml") || files.includes("build.gradle"))
            return "java";
        if (files.includes("tsconfig.json"))
            return "ts";
        if (files.includes("package.json"))
            return "js";
        if (files.includes("requirements.txt") || files.includes("pyproject.toml") || files.includes("Pipfile"))
            return "py";
        if (files.includes("go.mod"))
            return "go";
        if (files.includes("Cargo.toml"))
            return "rs";
        if (files.some(f => f.endsWith(".sln") || f.endsWith(".csproj")))
            return "cs";
        if (files.includes("composer.json"))
            return "php";
        if (files.includes("Gemfile"))
            return "rb";
        if (files.includes("CMakeLists.txt"))
            return "cpp";
        if (files.includes("Makefile") && files.some(f => f.endsWith(".c")))
            return "c";
        if (files.includes("pubspec.yaml"))
            return "dart";
        if (files.includes("mix.exs"))
            return "ex";
    }
    catch {
    }
    return undefined;
}
console.log(detectProjectLanguage("/Users/andriimishchenko/programming/project-selector"));
//# sourceMappingURL=test_lang.js.map