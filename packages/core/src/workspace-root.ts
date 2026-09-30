import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function findWorkspaceRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(join(current, 'pnpm-workspace.yaml')) &&
      existsSync(join(current, 'package.json'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function getWorkspaceRoot(): string {
  return resolve(
    process.env.WORKSPACE_ROOT?.trim() ||
    process.env.APEX_CANONICAL_REPO_ROOT?.trim() ||
    findWorkspaceRoot(process.cwd()) ||
    process.cwd(),
  );
}

export function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve an agent-supplied path within a workspace. Agents commonly use
 * `/workspace/...` (the cloud-agent mount) even when the deployed checkout is
 * mounted elsewhere, so that prefix is treated as an alias for `root`.
 */
export function resolveInWorkspace(root: string, path: string): string {
  const workspaceRoot = resolve(root);
  const normalized = path.replaceAll('\\', '/');
  let candidate: string;

  if (normalized === '/workspace' || normalized === 'workspace') {
    candidate = workspaceRoot;
  } else if (normalized.startsWith('/workspace/')) {
    candidate = resolve(workspaceRoot, normalized.slice('/workspace/'.length));
  } else if (normalized.startsWith('workspace/')) {
    candidate = resolve(workspaceRoot, normalized.slice('workspace/'.length));
  } else {
    candidate = resolve(workspaceRoot, path);
  }

  if (!pathWithin(workspaceRoot, candidate)) {
    throw new Error(`Path outside workspace: ${candidate}`);
  }

  const realWorkspaceRoot = realpathSync(workspaceRoot);
  let existingAncestor = candidate;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const realAncestor = realpathSync(existingAncestor);
  const realCandidate = resolve(realAncestor, relative(existingAncestor, candidate));
  if (!pathWithin(realWorkspaceRoot, realCandidate)) {
    throw new Error(`Path outside workspace through symlink: ${candidate}`);
  }
  return candidate;
}
