// @alienkind-core
/**
 * multimodal-scanner.ts — injection detection for non-text content.
 *
 * Extends text-based injection detection to three channels where
 * attackers hide payloads:
 *   1. OCR text from images (macOS Vision framework via Swift)
 *   2. EXIF metadata fields that can carry embedded strings
 *   3. Transcribed-audio text (from any transcription pipeline)
 *
 * macOS-specific for OCR today — uses the built-in Vision framework.
 * On Linux/Windows forkers, ocrImage returns empty and scanImage
 * degrades to "no findings" (safe default). Forkers wanting Linux OCR
 * wire tesseract or paddleocr in a wrapper.
 *
 * Usage:
 *   const { scanImage, scanExif, scanTranscription } =
 *     require('./multimodal-scanner.ts');
 *   const result = await scanImage('/path/to/image.png');
 *   if (result.detected) { / * handle injection * / }
 *
 * Readers: listener pipelines (image attachments, audio), email
 *   processing, agentdojo adversarial test suite.
 */

const { execSync } = require('child_process');
const fs = require('fs');

interface ScanResult {
  detected: boolean;
  severity: 'high' | 'medium' | 'low' | 'none';
  findings: string[];
  extractedText?: string;
}

// Subset of the text injection-detector patterns — applied to content
// extracted from images / EXIF / audio.
const TEXT_INJECTION_PATTERNS: { name: string; pattern: RegExp; severity: 'high' | 'medium' }[] = [
  { name: 'ignore_instructions', pattern: /ignore\s+(all\s+|the\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i, severity: 'high' },
  { name: 'system_prompt_override', pattern: /system\s*prompt\s*[:=]|you\s+are\s+now\s+a/i, severity: 'high' },
  { name: 'reveal_instructions', pattern: /reveal\s+(your\s+)?(system\s+)?(instructions|prompt|rules)/i, severity: 'high' },
  { name: 'print_env', pattern: /print\s+(your\s+)?env|process\.env|environment\s+variables/i, severity: 'high' },
  { name: 'pretend_to_be', pattern: /pretend\s+(you\s+are|to\s+be|you're)\s/i, severity: 'high' },
  { name: 'execute_command', pattern: /execute\s+(this\s+)?(command|script|code)\s*:/i, severity: 'high' },
  { name: 'new_instructions', pattern: /new\s+instructions?\s*[:=]/i, severity: 'high' },
  { name: 'emergency_override', pattern: /emergency\s+(override|access|protocol)/i, severity: 'medium' },
  { name: 'developer_mode', pattern: /(enable|activate|enter)\s+(developer|maintenance|debug)\s+mode/i, severity: 'medium' },
  { name: 'base64_payload', pattern: /base64\s*[:=]\s*[A-Za-z0-9+\/=]{40,}/i, severity: 'medium' },
];

// EXIF fields that commonly carry free-text payloads.
const SUSPICIOUS_EXIF_FIELDS = [
  'Comment', 'ImageDescription', 'UserComment', 'XPComment',
  'XPTitle', 'XPSubject', 'XPKeywords', 'DocumentName',
  'OwnerName', 'Artist', 'Copyright', 'Software',
];

/**
 * Extract text from an image using macOS Vision framework via Swift.
 * Returns empty string on non-macOS platforms or on any failure — safe
 * default.
 */
async function ocrImage(imagePath: string): Promise<string> {
  if (!fs.existsSync(imagePath)) return '';

  try {
    const script = `
import Vision
import Foundation
let url = URL(fileURLWithPath: "${imagePath.replace(/"/g, '\\"')}")
guard let imageSource = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
  exit(1)
}
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try handler.perform([request])
let results = request.results ?? []
for observation in results {
  if let candidate = observation.topCandidates(1).first {
    print(candidate.string)
  }
}
`;
    const tmpScript = '/tmp/alienkind-ocr.swift';
    fs.writeFileSync(tmpScript, script);
    const output = execSync(`swift ${tmpScript}`, { timeout: 30000, encoding: 'utf8' });
    return output.trim();
  } catch {
    return '';
  }
}

/** Scan an image for injection attempts via OCR. */
async function scanImage(imagePath: string): Promise<ScanResult> {
  const text = await ocrImage(imagePath);
  if (!text || text.length < 10) {
    return { detected: false, severity: 'none', findings: [], extractedText: text };
  }
  return scanExtractedText(text, 'image-ocr');
}

/** Scan EXIF metadata for suspicious content. */
function scanExif(imagePath: string): ScanResult {
  if (!fs.existsSync(imagePath)) {
    return { detected: false, severity: 'none', findings: ['File not found'] };
  }

  try {
    const metadata = execSync(`mdls -plist - "${imagePath.replace(/"/g, '\\"')}"`, {
      timeout: 10000,
      encoding: 'utf8',
    });

    const findings: string[] = [];
    let maxSeverity: 'high' | 'medium' | 'low' | 'none' = 'none';

    for (const field of SUSPICIOUS_EXIF_FIELDS) {
      const regex = new RegExp(`<key>${field}</key>\\s*<string>([^<]+)</string>`, 'i');
      const match = metadata.match(regex);
      if (!match || !match[1]) continue;
      const value = match[1];

      for (const pattern of TEXT_INJECTION_PATTERNS) {
        if (pattern.pattern.test(value)) {
          findings.push(`EXIF ${field} contains injection pattern: ${pattern.name}`);
          if (pattern.severity === 'high') maxSeverity = 'high';
          else if (maxSeverity !== 'high') maxSeverity = 'medium';
        }
      }

      if (value.length > 500) {
        findings.push(`EXIF ${field} suspiciously long (${value.length} chars)`);
        if (maxSeverity === 'none') maxSeverity = 'low';
      }

      if (/^[A-Za-z0-9+\/=]{100,}$/.test(value.trim())) {
        findings.push(`EXIF ${field} contains base64 payload (${value.length} chars)`);
        maxSeverity = 'medium';
      }
    }

    return {
      detected: findings.length > 0,
      severity: maxSeverity,
      findings,
    };
  } catch {
    return { detected: false, severity: 'none', findings: [] };
  }
}

/**
 * Scan transcribed audio text for injection patterns. Text comes from
 * an upstream transcription pipeline — this module doesn't transcribe.
 */
function scanTranscription(transcribedText: string): ScanResult {
  if (!transcribedText || transcribedText.length < 20) {
    return { detected: false, severity: 'none', findings: [], extractedText: transcribedText };
  }
  return scanExtractedText(transcribedText, 'audio-transcription');
}

/** Core text scanning — shared between OCR and transcription scanning. */
function scanExtractedText(text: string, source: string): ScanResult {
  const findings: string[] = [];
  let maxSeverity: 'high' | 'medium' | 'low' | 'none' = 'none';

  // Normalize Unicode — same approach as the text injection-detector.
  const normalized = text.normalize("NFKD").replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/g, "");

  for (const pattern of TEXT_INJECTION_PATTERNS) {
    if (pattern.pattern.test(normalized)) {
      findings.push(`${source}: ${pattern.name} detected`);
      if (pattern.severity === 'high') maxSeverity = 'high';
      else if (maxSeverity !== 'high') maxSeverity = pattern.severity;
    }
  }

  return {
    detected: findings.length > 0,
    severity: maxSeverity,
    findings,
    extractedText: text.slice(0, 500),
  };
}

module.exports = {
  scanImage,
  scanExif,
  scanTranscription,
  scanExtractedText,
  ocrImage,
};
