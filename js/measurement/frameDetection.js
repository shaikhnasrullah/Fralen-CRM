// INTEGRATION POINT. Reliable frame/lens-contour detection (A, B, DBL, ED, lens outline) needs a trained segmentation
// model; edge heuristics fail on reflections and rimless frames. Nothing is guessed here.
// Provide window.FRALEN_FRAME_DETECTOR(canvas, H) -> {A,B,DBL,ED,lensWidth,lensHeight,confidence} (mm, via homography H) from a CV backend/model.
export async function detectFrame(canvas,H){
  if(typeof window.FRALEN_FRAME_DETECTOR==='function')return window.FRALEN_FRAME_DETECTOR(canvas,H);
  return{status:'NOT_AVAILABLE',A:null,B:null,DBL:null,ED:null,confidence:0,message:'Not reliably detected'};
}
