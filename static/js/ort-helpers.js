/* ort-helpers.js — Phase 1 scaffolding for ONNX Runtime Web
 *
 * Wraps three ONNX models so checkpoint.html / register.html can swap
 * inference engines via ?engine=ort:
 *   - SCRFD-500MF       face detection + 5-point landmarks (det_500m.onnx)
 *   - MobileFaceNet     ArcFace 512-D embedding             (w600k_mbf.onnx)
 *   - PP-OCRv4 mobile   text-line recognition (rec only)    (ch_PP-OCRv4_rec_infer.onnx)
 *
 * Default checkpoint.html path stays face-api.js + Tesseract.js. This file
 * is only touched when the operator opens the page with ?engine=ort.
 *
 * Loading order:
 *   1. <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js"></script>
 *   2. <script src="/static/js/ort-helpers.js"></script>
 *
 * Public API (all on window.ortHelpers):
 *   loadFaceModels({scrfdUrl, mobilefacenetUrl, onProgress})
 *   loadOcrModel({recUrl, dictUrl, onProgress})
 *   detectAndEmbed(videoOrCanvas)            -> [{box, landmarks5, descriptor, detection}]
 *   detectAndEmbedSingle(canvas)             -> {box, landmarks5, descriptor, detection} | null
 *   cosineNearest(desc, registry)            -> {name, distance}   distance in [0, 2]
 *   recognizeOcrCrop(canvas)                 -> {data: {text, confidence}}   Tesseract-shaped
 *
 * Constants exported for the call sites:
 *   EMBEDDING_DIM = 512, SCRFD_INPUT_SIZE = 320, ARCFACE_INPUT_SIZE = 112
 */
(function (global) {
  'use strict';

  // ── Tunables ─────────────────────────────────────────────────────────
  const SCRFD_INPUT_SIZE = 320;        // matches face-api FACE_DETECTOR_INPUT_SIZE
  const SCRFD_SCORE_THRESHOLD = 0.5;   // matches FACE_DETECTOR_SCORE_THRESHOLD
  const SCRFD_NMS_IOU = 0.4;           // tuned for crowded scenes (per plan §1A note)
  const SCRFD_NUM_ANCHORS = 2;         // SCRFD-500M uses 2 anchors per FPN cell
  const SCRFD_FEAT_STRIDES = [8, 16, 32];
  const ARCFACE_INPUT_SIZE = 112;
  const EMBEDDING_DIM = 512;
  const OCR_REC_HEIGHT = 48;           // PP-OCRv4 mobile rec input H
  const OCR_REC_WIDTH = 320;           // input W (padded; dynamic-W skipped for Phase 1)

  // Standard InsightFace ArcFace 5-point template (in 112×112 canonical space).
  // Aligning every face to this template before MobileFaceNet is the
  // non-negotiable preprocessing step ArcFace was trained against.
  const ARCFACE_DST = [
    [38.2946, 51.6963], // left  eye
    [73.5318, 51.5014], // right eye
    [56.0252, 71.7366], // nose tip
    [41.5493, 92.3655], // left  mouth corner
    [70.7299, 92.2041], // right mouth corner
  ];

  // ── Module state ─────────────────────────────────────────────────────
  let detectorSession = null;
  let recognizerSession = null;
  let ocrRecSession = null;
  let ocrCharDict = null;     // ['blank', ...chars, ' '] — index = model class id

  // ── Init: ORT runtime config + model load ────────────────────────────

  // Configure the ORT runtime ONCE per page. Idempotent — safe to re-call.
  let ortConfigured = false;
  function configureOrt() {
    if (ortConfigured) return;
    if (typeof ort === 'undefined') {
      throw new Error('[ortHelpers] window.ort missing — load onnxruntime-web@1.18.0 before ort-helpers.js');
    }
    // Use the CDN-hosted wasm binaries that ship with the same version.
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
    ort.env.wasm.simd = true;
    // Multi-thread WASM requires cross-origin-isolated context (COOP/COEP
    // headers). Flask's default dev server does NOT set these, so threads
    // typically fall back to 1. Setting numThreads here is best-effort.
    try {
      const cores = navigator.hardwareConcurrency || 1;
      ort.env.wasm.numThreads = Math.max(1, Math.min(4, cores));
    } catch (_) { /* ignore */ }
    ortConfigured = true;
  }

  async function loadFaceModels({ scrfdUrl, mobilefacenetUrl, onProgress }) {
    configureOrt();
    const sessOpts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    if (onProgress) onProgress('detector');
    detectorSession = await ort.InferenceSession.create(scrfdUrl, sessOpts);
    if (onProgress) onProgress('recognizer');
    recognizerSession = await ort.InferenceSession.create(mobilefacenetUrl, sessOpts);
    return { detectorSession, recognizerSession };
  }

  async function loadOcrModel({ recUrl, dictUrl, onProgress }) {
    configureOrt();
    if (onProgress) onProgress('ocr-rec');
    ocrRecSession = await ort.InferenceSession.create(recUrl, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all',
    });
    if (onProgress) onProgress('ocr-dict');
    const resp = await fetch(dictUrl);
    if (!resp.ok) throw new Error('Failed to fetch OCR dict: ' + resp.status);
    const text = await resp.text();
    const lines = text.replace(/\r/g, '').split('\n').filter(line => line.length > 0);
    // PaddleOCR CTC convention: index 0 = <blank>, indices 1..N = chars, N+1 = ' ' (use_space_char=True).
    // Output channel count of the rec model should equal lines.length + 2.
    ocrCharDict = ['<blank>'].concat(lines).concat([' ']);
    return {
      // Mimic Tesseract worker.recognize() result shape
      recognize: (canvas) => recognizeOcrCrop(canvas),
    };
  }

  // ── SCRFD detection ──────────────────────────────────────────────────

  async function detectFaces(videoOrCanvas) {
    const { width, height } = sourceSize(videoOrCanvas);
    if (!width || !height) return [];

    const { tensor, scale } = preprocessSCRFD(videoOrCanvas, width, height);
    const inputName = detectorSession.inputNames[0];
    const outputs = await detectorSession.run({ [inputName]: tensor });

    const detsInputSpace = decodeSCRFD(outputs);

    // Map back to original image coordinates (top-left letterbox: divide by scale)
    for (const det of detsInputSpace) {
      det.box.x /= scale;
      det.box.y /= scale;
      det.box.width /= scale;
      det.box.height /= scale;
      for (let i = 0; i < det.landmarks5.length; i++) {
        det.landmarks5[i][0] /= scale;
        det.landmarks5[i][1] /= scale;
      }
    }
    return detsInputSpace;
  }

  function sourceSize(src) {
    if (src.videoWidth) return { width: src.videoWidth, height: src.videoHeight };
    return { width: src.width || 0, height: src.height || 0 };
  }

  // Letterbox top-left to SCRFD_INPUT_SIZE×SCRFD_INPUT_SIZE, RGB, NCHW float32,
  // normalized as (px - 127.5) / 128.0 (InsightFace SCRFD convention).
  function preprocessSCRFD(src, srcW, srcH) {
    const inputW = SCRFD_INPUT_SIZE, inputH = SCRFD_INPUT_SIZE;
    const scale = Math.min(inputW / srcW, inputH / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);

    const cnv = document.createElement('canvas');
    cnv.width = inputW;
    cnv.height = inputH;
    const ctx = cnv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, inputW, inputH);
    ctx.drawImage(src, 0, 0, newW, newH); // top-left aligned

    const px = ctx.getImageData(0, 0, inputW, inputH).data;
    const plane = inputW * inputH;
    const arr = new Float32Array(3 * plane);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      arr[j]             = (px[i]     - 127.5) / 128.0; // R
      arr[j +     plane] = (px[i + 1] - 127.5) / 128.0; // G
      arr[j + 2 * plane] = (px[i + 2] - 127.5) / 128.0; // B
    }
    const tensor = new ort.Tensor('float32', arr, [1, 3, inputH, inputW]);
    return { tensor, scale };
  }

  // Decode SCRFD outputs across 3 strides. Output names depend on the
  // ONNX export, so we group by tensor shape: last-dim 1 = scores,
  // 4 = bbox distances, 10 = 5-pt landmark distances.
  function decodeSCRFD(outputs) {
    const scoreOuts = [], bboxOuts = [], kpsOuts = [];
    for (const name of Object.keys(outputs)) {
      const t = outputs[name];
      const lastDim = t.dims[t.dims.length - 1];
      if (lastDim === 1) scoreOuts.push(t);
      else if (lastDim === 4) bboxOuts.push(t);
      else if (lastDim === 10) kpsOuts.push(t);
      // lastDim===8 (no-kps SCRFD variant) intentionally unsupported here
    }
    if (scoreOuts.length !== 3 || bboxOuts.length !== 3 || kpsOuts.length !== 3) {
      console.warn('[ortHelpers] SCRFD outputs unexpected:',
        { scores: scoreOuts.length, bboxes: bboxOuts.length, kps: kpsOuts.length });
      return [];
    }
    // Sort each by N descending so index 0 = stride 8, 1 = stride 16, 2 = stride 32
    const byNDesc = (a, b) => {
      const aN = a.dims[a.dims.length - 2];
      const bN = b.dims[b.dims.length - 2];
      return bN - aN;
    };
    scoreOuts.sort(byNDesc);
    bboxOuts.sort(byNDesc);
    kpsOuts.sort(byNDesc);

    const dets = [];
    for (let s = 0; s < 3; s++) {
      const stride = SCRFD_FEAT_STRIDES[s];
      const featH = Math.ceil(SCRFD_INPUT_SIZE / stride);
      const featW = Math.ceil(SCRFD_INPUT_SIZE / stride);
      const scores = scoreOuts[s].data;
      const bboxes = bboxOuts[s].data;
      const kps    = kpsOuts[s].data;

      let idx = 0;
      for (let h = 0; h < featH; h++) {
        for (let w = 0; w < featW; w++) {
          for (let a = 0; a < SCRFD_NUM_ANCHORS; a++, idx++) {
            const score = scores[idx];
            if (score < SCRFD_SCORE_THRESHOLD) continue;

            const cx = w * stride;
            const cy = h * stride;

            const x1 = cx - bboxes[idx * 4 + 0] * stride;
            const y1 = cy - bboxes[idx * 4 + 1] * stride;
            const x2 = cx + bboxes[idx * 4 + 2] * stride;
            const y2 = cy + bboxes[idx * 4 + 3] * stride;

            const lm = [];
            for (let k = 0; k < 5; k++) {
              lm.push([
                cx + kps[idx * 10 + k * 2]     * stride,
                cy + kps[idx * 10 + k * 2 + 1] * stride,
              ]);
            }

            dets.push({
              box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
              landmarks5: lm,
              score,
            });
          }
        }
      }
    }
    return nms(dets, SCRFD_NMS_IOU);
  }

  function nms(dets, iouThr) {
    dets.sort((a, b) => b.score - a.score);
    const keep = [];
    const drop = new Array(dets.length).fill(false);
    for (let i = 0; i < dets.length; i++) {
      if (drop[i]) continue;
      keep.push(dets[i]);
      for (let j = i + 1; j < dets.length; j++) {
        if (drop[j]) continue;
        if (iou(dets[i].box, dets[j].box) > iouThr) drop[j] = true;
      }
    }
    return keep;
  }

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 <= x1 || y2 <= y1) return 0;
    const inter = (x2 - x1) * (y2 - y1);
    return inter / (a.width * a.height + b.width * b.height - inter);
  }

  // ── Affine warp via complex-number similarity fit ────────────────────

  // Solve [a -b; b a] * src + t = dst least-squares (no reflection,
  // equivalent to InsightFace's skimage.SimilarityTransform). Returns the
  // 2×3 matrix that maps src points to dst points.
  function similarityTransform(srcPts, dstPts) {
    const n = srcPts.length;
    let smx = 0, smy = 0, dmx = 0, dmy = 0;
    for (let i = 0; i < n; i++) {
      smx += srcPts[i][0]; smy += srcPts[i][1];
      dmx += dstPts[i][0]; dmy += dstPts[i][1];
    }
    smx /= n; smy /= n; dmx /= n; dmy /= n;
    let aRe = 0, aIm = 0, denom = 0;
    for (let i = 0; i < n; i++) {
      const sx = srcPts[i][0] - smx, sy = srcPts[i][1] - smy;
      const dx = dstPts[i][0] - dmx, dy = dstPts[i][1] - dmy;
      aRe += dx * sx + dy * sy;
      aIm += dy * sx - dx * sy;
      denom += sx * sx + sy * sy;
    }
    if (denom === 0) return [[1, 0, dmx - smx], [0, 1, dmy - smy]];
    const aR = aRe / denom, aI = aIm / denom;
    const tx = dmx - (aR * smx - aI * smy);
    const ty = dmy - (aI * smx + aR * smy);
    return [[aR, -aI, tx], [aI, aR, ty]];
  }

  // Warp the source image so that srcLandmarks5 land on ARCFACE_DST in a
  // 112×112 canvas. Returns the canvas (caller can read pixels for embed).
  function affineWarp112(src, srcLandmarks5) {
    const M = similarityTransform(srcLandmarks5, ARCFACE_DST);
    const out = document.createElement('canvas');
    out.width = ARCFACE_INPUT_SIZE;
    out.height = ARCFACE_INPUT_SIZE;
    const ctx = out.getContext('2d');
    // Canvas2D setTransform args are (a, b, c, d, e, f) where the matrix is
    // | a c e |   so a = M[0][0], b = M[1][0], c = M[0][1], d = M[1][1],
    // | b d f |       e = M[0][2], f = M[1][2].
    ctx.setTransform(M[0][0], M[1][0], M[0][1], M[1][1], M[0][2], M[1][2]);
    ctx.drawImage(src, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return out;
  }

  // ── MobileFaceNet embedding ──────────────────────────────────────────

  async function embedFace(canvas112) {
    const ctx = canvas112.getContext('2d');
    const px = ctx.getImageData(0, 0, ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE).data;
    const plane = ARCFACE_INPUT_SIZE * ARCFACE_INPUT_SIZE;
    const arr = new Float32Array(3 * plane);
    // ArcFace input normalization: (px - 127.5) / 127.5  →  [-1, 1], NCHW, RGB.
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      arr[j]             = (px[i]     - 127.5) / 127.5;
      arr[j +     plane] = (px[i + 1] - 127.5) / 127.5;
      arr[j + 2 * plane] = (px[i + 2] - 127.5) / 127.5;
    }
    const tensor = new ort.Tensor('float32', arr, [1, 3, ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE]);
    const inputName = recognizerSession.inputNames[0];
    const out = await recognizerSession.run({ [inputName]: tensor });
    const outName = recognizerSession.outputNames[0];
    return l2normalize(new Float32Array(out[outName].data));
  }

  function l2normalize(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    const n = Math.sqrt(s) || 1.0;
    for (let i = 0; i < arr.length; i++) arr[i] /= n;
    return arr;
  }

  // ── End-to-end face: detect + warp + embed ───────────────────────────

  async function detectAndEmbed(videoOrCanvas) {
    if (!detectorSession || !recognizerSession) {
      throw new Error('[ortHelpers] face models not loaded — call loadFaceModels first');
    }
    const dets = await detectFaces(videoOrCanvas);
    const out = [];
    for (const det of dets) {
      try {
        const aligned = affineWarp112(videoOrCanvas, det.landmarks5);
        const desc = await embedFace(aligned);
        out.push({
          box: det.box,
          landmarks5: det.landmarks5,
          descriptor: desc,
          detection: { score: det.score },
        });
      } catch (e) {
        console.warn('[ortHelpers] embedding failed for one face:', e);
      }
    }
    return out;
  }

  async function detectAndEmbedSingle(canvas) {
    const all = await detectAndEmbed(canvas);
    if (all.length === 0) return null;
    all.sort((a, b) => b.detection.score - a.detection.score);
    return all[0];
  }

  // ── Cosine match against in-memory registry ──────────────────────────

  // registry shape: { [name: string]: Float32Array(EMBEDDING_DIM) }
  // Returns { name, distance } where distance ∈ [0, 2] (1 - cosine_similarity).
  // Both descriptors MUST be unit-length for this to be a true cosine distance.
  function cosineNearest(desc, registry) {
    let bestName = 'unknown', bestDist = 2.0;
    for (const name in registry) {
      const reg = registry[name];
      let dot = 0;
      const n = desc.length;
      for (let i = 0; i < n; i++) dot += desc[i] * reg[i];
      const d = 1 - dot;
      if (d < bestDist) { bestDist = d; bestName = name; }
    }
    return { name: bestName, distance: bestDist };
  }

  // ── PaddleOCR PP-OCRv4 mobile rec ────────────────────────────────────

  async function recognizeOcrCrop(canvasOrImg) {
    if (!ocrRecSession) {
      throw new Error('[ortHelpers] OCR rec model not loaded — call loadOcrModel first');
    }
    const tensor = preprocessOcrCrop(canvasOrImg);
    const inputName = ocrRecSession.inputNames[0];
    const out = await ocrRecSession.run({ [inputName]: tensor });
    const outName = ocrRecSession.outputNames[0];
    const decoded = ctcDecode(out[outName]);
    // Mimic Tesseract.js worker.recognize() so call sites consume identically.
    return { data: { text: decoded.text, confidence: decoded.confidence } };
  }

  function preprocessOcrCrop(src) {
    // Coerce to canvas (src may be canvas, image, or any drawImage-compatible)
    let cnv = src;
    if (!(src instanceof HTMLCanvasElement)) {
      cnv = document.createElement('canvas');
      cnv.width = src.width || src.naturalWidth || OCR_REC_WIDTH;
      cnv.height = src.height || src.naturalHeight || OCR_REC_HEIGHT;
      cnv.getContext('2d').drawImage(src, 0, 0);
    }
    const srcH = cnv.height, srcW = cnv.width;
    const ratio = srcW / Math.max(srcH, 1);
    let resizedW = Math.round(OCR_REC_HEIGHT * ratio);
    if (resizedW > OCR_REC_WIDTH) resizedW = OCR_REC_WIDTH;

    const scaled = document.createElement('canvas');
    scaled.width = OCR_REC_WIDTH;
    scaled.height = OCR_REC_HEIGHT;
    const ctx = scaled.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, OCR_REC_WIDTH, OCR_REC_HEIGHT);
    ctx.drawImage(cnv, 0, 0, resizedW, OCR_REC_HEIGHT);

    const px = ctx.getImageData(0, 0, OCR_REC_WIDTH, OCR_REC_HEIGHT).data;
    const plane = OCR_REC_WIDTH * OCR_REC_HEIGHT;
    const arr = new Float32Array(3 * plane);
    // PP-OCRv4 rec normalization: (px/255 - 0.5) / 0.5  →  [-1, 1], RGB, NCHW.
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      arr[j]             = (px[i]     / 255.0 - 0.5) / 0.5;
      arr[j +     plane] = (px[i + 1] / 255.0 - 0.5) / 0.5;
      arr[j + 2 * plane] = (px[i + 2] / 255.0 - 0.5) / 0.5;
    }
    return new ort.Tensor('float32', arr, [1, 3, OCR_REC_HEIGHT, OCR_REC_WIDTH]);
  }

  // CTC greedy decode. Output tensor shape: [1, T, C].
  // C should equal ocrCharDict.length; warn-once if not.
  let ctcShapeWarned = false;
  function ctcDecode(out) {
    const dims = out.dims;
    const T = dims[1], C = dims[2];
    if (!ctcShapeWarned && C !== ocrCharDict.length) {
      console.warn('[ortHelpers] OCR class count mismatch:',
        'model C =', C, 'dict length =', ocrCharDict.length,
        '— decoded chars may be off-by-one. Adjust dict to match model export.');
      ctcShapeWarned = true;
    }
    const data = out.data;
    let lastIdx = 0;
    let confSum = 0, confCount = 0;
    const chars = [];
    for (let t = 0; t < T; t++) {
      let bestIdx = 0, bestVal = -Infinity;
      for (let c = 0; c < C; c++) {
        const v = data[t * C + c];
        if (v > bestVal) { bestVal = v; bestIdx = c; }
      }
      // CTC collapse: drop repeats and blank (index 0)
      if (bestIdx !== 0 && bestIdx !== lastIdx) {
        const ch = (bestIdx < ocrCharDict.length) ? ocrCharDict[bestIdx] : '';
        if (ch && ch !== '<blank>') {
          chars.push(ch);
          confSum += bestVal;
          confCount++;
        }
      }
      lastIdx = bestIdx;
    }
    const text = chars.join('');
    // PP-OCRv4 ONNX export has softmax in the graph, so bestVal ∈ [0, 1].
    // Multiply by 100 to give Tesseract-shaped 0–100 confidence.
    const confidence = confCount > 0 ? (confSum / confCount) * 100 : 0;
    return { text, confidence };
  }

  // ── Public surface ───────────────────────────────────────────────────
  global.ortHelpers = {
    loadFaceModels,
    loadOcrModel,
    detectAndEmbed,
    detectAndEmbedSingle,
    cosineNearest,
    recognizeOcrCrop,
    affineWarp112,
    embedFace,
    l2normalize,
    EMBEDDING_DIM,
    SCRFD_INPUT_SIZE,
    ARCFACE_INPUT_SIZE,
  };
})(typeof window !== 'undefined' ? window : this);
