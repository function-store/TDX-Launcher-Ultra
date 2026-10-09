/** Package-index catalog types/helpers (index-agnostic; PyPI by default). */

export type TdpRemotePackage = {
  id: string;
  name: string;
  summary: string;
  version: string;
  tags: string[];
  homePage: string;
  projectUrl: string;
  spec: string;
  module: string;
  yanked: boolean;
};

export type TdpRemoteCatalog = {
  source: string;
  fetchedAt: number;
  packages: TdpRemotePackage[];
  fromCache: boolean;
};

export type TdpReadme = {
  name: string;
  markdown: string;
  sourceUrl: string;
};

export function packageInstallSpec(pkg: TdpRemotePackage): string {
  // Only attach a module hint when it looks like a real dotted import path.
  // Flat guesses like "tdptauceti" are wrong for packages such as tdp-TauCeti
  // (actual: tdpTauCeti.PresetManager) and used to make the loader fall back
  // to whatever ToxFile was already in the vEnv (often tdpBrowser).
  if (!pkg.module || pkg.module === "unknown" || !pkg.module.includes(".")) {
    return pkg.spec;
  }
  return `${pkg.spec}#${pkg.module}`;
}

export function packageMatchesQuery(pkg: TdpRemotePackage, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  const hay = [pkg.name, pkg.summary, pkg.module, pkg.spec, pkg.version, ...pkg.tags]
    .join(" ")
    .toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}
