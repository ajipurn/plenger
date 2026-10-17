export declare const db: {
  user: {
    findMany(): Promise<unknown[]>;
    delete(query: { where: { id: string } }): Promise<unknown>;
  };
};
