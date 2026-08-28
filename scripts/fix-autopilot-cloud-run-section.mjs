import fs from 'node:fs';

const path = '.agents/skills/apex-autopilot/SKILL.md';
const text = fs.readFileSync(path, 'utf8');
const startMarker = '## 7. Deployment Contract — APEX Itself\n';
const endMarker = '## 8. Business Autopilot\n';
const start = text.indexOf(startMarker);
const end = text.indexOf(endMarker);
if (start < 0 || end <= start) {
  throw new Error('Could not locate Autopilot deployment section boundaries');
}

const section = `## 7. Deployment Contract — APEX Itself

Do not conflate client-project deployment tooling with APEX's own host.

APEX production runs on the **existing Google Cloud Run service** behind \`https://apex.donmatthews.live\`. Re-check \`AGENTS.md\`, \`docs/PRODUCTION_OPERATIONS.md\`, and direct live evidence before acting because infrastructure can change only through an explicit architecture decision.

Current expected sequence is conceptually:

1. Identify the exact intended reviewed commit and require green CI.
2. Resolve the existing Google Cloud project, region, and Cloud Run service from trusted configuration; never guess or create a substitute service.
3. Confirm the authenticated Google identity can describe that exact existing service.
4. Build the exact clean commit with Google Cloud Build using \`cloudbuild.apex.yaml\` and an immutable SHA-derived image tag.
5. Update only the existing Cloud Run service image with \`gcloud run services update\` so existing secrets, environment, service account, scaling, ingress, resources, and domain mapping are preserved.
6. Wait for the new revision to become Ready.
7. Call the public \`/health\` endpoint and confirm \`build.sha\` equals the intended commit and the task queue is healthy.
8. Smoke-test the changed feature through the real production path.

A successful Cloud Build is not a deployment. A Ready Cloud Run revision is not enough without public live-commit and feature verification.

Rollback is also a production mutation and remains gated. When rollback is needed, prepare the previous known-good Cloud Run revision and verification plan before requesting approval, then verify public health after traffic is restored.

`;

fs.writeFileSync(path, text.slice(0, start) + section + text.slice(end));
