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
exports.default = MultimodalInput;
const react_1 = __importStar(require("react"));
function MultimodalInput({ value, onChange, onSubmit, loading }) {
    const [listening, setListening] = (0, react_1.useState)(false);
    const [speechSupported, setSpeechSupported] = (0, react_1.useState)(null);
    const [speechError, setSpeechError] = (0, react_1.useState)(null);
    const recognitionRef = (0, react_1.useRef)(null);
    react_1.default.useEffect(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        setSpeechSupported(!!SpeechRecognition);
    }, []);
    const handleMicClick = () => {
        setSpeechError(null);
        if (listening) {
            recognitionRef.current?.stop();
            setListening(false);
            return;
        }
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition)
            return;
        const recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            onChange(value && !value.trim().endsWith('.') && !value.trim().endsWith('?') && !value.trim().endsWith('!') ? (value.trim() + ' ' + transcript) : transcript);
            setListening(false);
        };
        recognition.onerror = () => {
            setListening(false);
            setSpeechError('Voice input error. Please try again.');
        };
        recognition.onend = () => {
            setListening(false);
        };
        recognitionRef.current = recognition;
        recognition.start();
        setListening(true);
    };
    return (<div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 520, margin: 0, justifyContent: 'center', position: 'relative', zIndex: 2 }}>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder="Ask about a player, card, or market..." style={{ flex: 1, padding: 14, fontSize: 17, border: '1.5px solid #b6c6e3', borderRadius: 8, background: '#fff', outline: 'none', boxShadow: '0 1px 4px #0001', transition: 'border 0.2s' }} disabled={loading} autoFocus onKeyDown={e => { if (e.key === 'Enter') {
        e.preventDefault();
        onSubmit();
    } }}/>
      {/* Microphone button */}
      <button type="button" aria-label={listening ? "Stop listening" : "Start voice input"} onClick={handleMicClick} disabled={loading || speechSupported === false} style={{
            border: 'none',
            background: listening ? '#b2e0ff' : '#f0f4ff',
            color: listening ? '#1976d2' : '#1976d2',
            borderRadius: '50%',
            width: 44,
            height: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            marginLeft: 0,
            marginRight: 0,
            boxShadow: listening ? '0 0 0 2px #1976d2' : '0 1px 4px #0001',
            cursor: loading ? 'not-allowed' : 'pointer',
            outline: listening ? '2px solid #1976d2' : 'none',
            transition: 'background 0.2s, color 0.2s, box-shadow 0.2s'
        }}>
        {listening ? (<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="22" height="22" rx="11" fill="none"/>
            <rect x="7" y="10" width="8" height="2.5" rx="1.2" fill="#1976d2"/>
          </svg>) : (<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="22" height="22" rx="11" fill="none"/>
            <path d="M11 15c1.933 0 3.5-1.567 3.5-3.5v-4A3.5 3.5 0 0 0 7.5 7.5v4A3.5 3.5 0 0 0 11 15Zm5-3.5a.75.75 0 0 0-1.5 0 4 4 0 0 1-8 0 .75.75 0 0 0-1.5 0 5.5 5.5 0 0 0 4.75 5.45V20a.75.75 0 0 0 1.5 0v-3.05A5.5 5.5 0 0 0 16 11.5Z" fill="#1976d2"/>
          </svg>)}
      </button>
      <button type="button" disabled={loading || !value.trim()} onClick={onSubmit} style={{ padding: "12px 24px", borderRadius: 8, border: 'none', background: '#1976d2', color: '#fff', fontWeight: 600, fontSize: 17, boxShadow: '0 1px 4px #0001', cursor: loading ? 'not-allowed' : 'pointer', transition: 'background 0.2s' }}>
        {loading ? "Searching..." : "Search"}
      </button>
      {/* Speech recognition not supported message */}
      {speechSupported === false && (<div style={{ color: '#b71c1c', position: 'absolute', top: 54, left: 0, right: 0, fontSize: 15, textAlign: 'center', width: '100%' }}>
          Voice search is not supported in this browser.
        </div>)}
      {listening && (<div style={{ color: '#1976d2', position: 'absolute', top: 54, left: 0, right: 0, fontSize: 15, textAlign: 'center', width: '100%', fontWeight: 600, letterSpacing: 1 }}>
          <span style={{ display: 'inline-block', marginRight: 8, verticalAlign: 'middle' }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" fill="#b2e0ff" stroke="#1976d2" strokeWidth="2"/><circle cx="9" cy="9" r="3" fill="#1976d2"/></svg>
          </span>
          Listening... Speak now.
        </div>)}
      {speechError && (<div style={{ color: '#b71c1c', position: 'absolute', top: 54, left: 0, right: 0, fontSize: 15, textAlign: 'center', width: '100%' }}>{speechError}</div>)}
    </div>);
}
