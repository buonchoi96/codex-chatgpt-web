export class ChatGptAgentSessionGraph {
  private readonly children = new Map<string, Set<string>>();
  private readonly references = new Map<string, Map<string, string>>();
  private readonly pendingReferences = new Map<string, string[]>();

  link(parent: string, child: string): void {
    if (!parent || !child || parent === child) return;
    const children = this.children.get(parent) ?? new Set<string>();
    children.add(child);
    this.children.set(parent, children);
    this.reconcile(parent);
  }

  linkReference(parent: string, reference: string): void {
    if (!parent || !reference) return;
    const references = this.references.get(parent);
    if (references?.has(reference)) return;
    const pending = this.pendingReferences.get(parent) ?? [];
    if (!pending.includes(reference)) pending.push(reference);
    this.pendingReferences.set(parent, pending);
    this.reconcile(parent);
  }

  resolveReference(parent: string, reference: string): string | undefined {
    const references = this.references.get(parent);
    if (!references) return undefined;
    const exact = references.get(reference);
    if (exact) return exact;
    if (reference.startsWith("/")) return undefined;
    const matches = [...references]
      .filter(([candidate]) => candidate.endsWith(`/${reference}`))
      .map(([, child]) => child);
    return matches.length === 1 ? matches[0] : undefined;
  }

  descendants(threadId: string): string[] {
    const result = [threadId];
    for (let index = 0; index < result.length; index += 1) {
      result.push(...(this.children.get(result[index]!) ?? []));
    }
    return [...new Set(result)];
  }

  forget(threadIds: Iterable<string>): void {
    const forgotten = new Set(threadIds);
    for (const id of forgotten) {
      this.children.delete(id);
      this.references.delete(id);
      this.pendingReferences.delete(id);
    }
    for (const children of this.children.values()) {
      for (const id of forgotten) children.delete(id);
    }
    for (const references of this.references.values()) {
      for (const [reference, id] of references) if (forgotten.has(id)) references.delete(reference);
    }
  }

  clear(): void {
    this.children.clear();
    this.references.clear();
    this.pendingReferences.clear();
  }

  private reconcile(parent: string): void {
    const children = this.children.get(parent);
    const pending = this.pendingReferences.get(parent);
    if (!children?.size || !pending?.length) return;
    const references = this.references.get(parent) ?? new Map<string, string>();
    const bound = new Set(references.values());
    const unboundChildren = [...children].filter(child => !bound.has(child));
    const unboundReferences = pending.filter(reference => !references.has(reference));
    if (unboundChildren.length !== 1 || unboundReferences.length !== 1) return;
    references.set(unboundReferences[0]!, unboundChildren[0]!);
    this.references.set(parent, references);
    this.pendingReferences.delete(parent);
  }
}
