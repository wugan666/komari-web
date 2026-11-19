/**
 * The owned server returns public:queryMetrics points as compact tuples
 * ([unix_ms, value|null, count, labels?]) marked point_format "points_v1".
 * Expand them to the object points the UI uses; other results pass through.
 */
export function decodeMetricResult<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.series)) return value;
  if (!result.series.some((s) => (s as Record<string, unknown>)?.point_format === "points_v1")) return value;
  const series = result.series.map((item: unknown) => {
    const entry = item as Record<string, unknown>;
    if (entry?.point_format !== "points_v1" || !Array.isArray(entry.points)) return item;
    const { point_format: _format, ...rest } = entry;
    return {
      ...rest,
      points: entry.points.map((tuple: unknown) => {
        if (!Array.isArray(tuple) || tuple.length < 3) throw new Error("Invalid compact metric sample");
        return {
          time: new Date(tuple[0] as number).toISOString(),
          value: tuple[1] as number | null,
          count: tuple[2] as number,
          tags: entry.tags,
          ...(tuple[3] === undefined ? {} : { labels: tuple[3] }),
        };
      }),
    };
  });
  return { ...result, series } as T;
}
