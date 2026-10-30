/** Remove an optional UTF-8 BOM before handing TOML text to smol-toml. */
export function withoutTomlBom(source: string): string {
  return source.replace(/^\uFEFF/, '');
}