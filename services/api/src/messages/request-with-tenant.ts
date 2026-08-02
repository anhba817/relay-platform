// The request shape both the guard and the repository factory read
// (chapter 2.2). Part 3 replaces the header with real credentials; this
// type is the seam that keeps that swap to one file.
export interface RequestWithTenant {
  headers: Record<string, string | undefined>;
}
