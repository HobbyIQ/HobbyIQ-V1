"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const service_1 = require("../search/service");
const router = express_1.default.Router();
// POST /api/search
router.post('/', async (req, res) => {
    const body = req.body;
    const result = await (0, service_1.handleSearch)(body);
    res.status(result.ok ? 200 : 400).json(result);
});
exports.default = router;
