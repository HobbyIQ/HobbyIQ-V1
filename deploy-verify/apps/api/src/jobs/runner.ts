// Mock job runner for HobbyIQ
export async function runAllJobs() {
  // Simulate running background jobs
  return { status: "ok", jobsRun: ["refreshComps", "refreshSupply", "refreshPerformance"] };
}
