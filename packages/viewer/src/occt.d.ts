declare module 'occt-import-js' {
  export interface OcctMesh {
    name: string;
    color?: [number, number, number];
    brep_faces: { first: number; last: number; color: [number, number, number] | null }[];
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }
  export interface OcctResult {
    success: boolean;
    meshes: OcctMesh[];
  }
  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: unknown): OcctResult;
  }
  const occtimportjs: (opts?: { locateFile?: (path: string) => string }) => Promise<OcctModule>;
  export default occtimportjs;
}
