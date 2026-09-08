import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { sessions: {}, memories: [], evaluations: [], traces: [], evalRuns: [] };
    this.ready = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.ready) return this.state;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.state = { ...this.state, ...JSON.parse(await readFile(this.filePath, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.ready = true;
    return this.state;
  }

  async save() {
    await this.load();
    this.writeQueue = this.writeQueue.then(async () => {
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(this.state, null, 2));
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}
