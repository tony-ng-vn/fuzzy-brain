export type BrainNode = {
  id: string;
  type: string;
  title: string;
  body: string;
  raw: string;
  created_at: string;
  x?: number;
  y?: number;
};

export type BrainEdge = {
  id: string;
  // The force simulation replaces id strings with node objects once it takes over.
  source: string | BrainNode;
  target: string | BrainNode;
  why: string;
  created_at: string;
};
