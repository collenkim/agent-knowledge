/** 로캘에 따라 순서가 달라지면 결과가 바이트 단위로 재현되지 않으므로 코드 유닛으로 비교한다. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort(compareStrings);
}
