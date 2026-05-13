export type ExpandableTreeNode = {
  id: string;
  children?: ExpandableTreeNode[];
};

export function collectExpandableIds(nodes: readonly ExpandableTreeNode[]): string[] {
  return nodes.flatMap((node) => {
    if (!node.children?.length) return [];
    return [node.id, ...collectExpandableIds(node.children)];
  });
}

export function toggleExpandedNodeIds(
  expandedIds: Iterable<string>,
  node: ExpandableTreeNode,
  recursive: boolean,
): string[] {
  const next = new Set(expandedIds);
  const ids = recursive && node.children?.length ? collectExpandableIds([node]) : [node.id];
  const shouldCollapse = next.has(node.id);

  for (const id of ids) {
    if (shouldCollapse) next.delete(id);
    else next.add(id);
  }

  return [...next];
}
