// @workspace/orchestrator is registered in the workspace but has no
// implementation yet — real orchestration lives in @workspace/multiapp today.
// This empty export keeps the package a valid module so the workspace
// typecheck stays green. Safe to delete this package entirely if it stays unused.
export {};
