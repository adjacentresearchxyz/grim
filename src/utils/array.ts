export const partition = <T>(
  array: T[],
  predicate: (item: T) => boolean
): [T[], T[]] =>
  array.reduce<[T[], T[]]>(
    ([matches, nonMatches], item) =>
      predicate(item)
        ? [[...matches, item], nonMatches]
        : [matches, [...nonMatches, item]],
    [[], []]
  ); 