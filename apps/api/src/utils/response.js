"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
function ok(data, meta) {
    return { success: true, data, meta };
}
function fail(error, meta) {
    return { success: false, error, meta };
}
