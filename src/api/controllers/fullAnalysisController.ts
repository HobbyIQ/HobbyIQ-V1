import { runFullAnalysis } from '../../brain/handlers/fullAnalysisHandler';

export async function fullAnalysisController(req, res) {
  try {
    console.log('[FullAnalysisController] Incoming request:', JSON.stringify(req.body));
    const result = await runFullAnalysis(req.body || {});
    console.log('[FullAnalysisController] Final response:', JSON.stringify(result));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[FullAnalysisController] Error:', err);
    res.status(500).json({ success: false, error: 'Full analysis failed' });
  }
}
