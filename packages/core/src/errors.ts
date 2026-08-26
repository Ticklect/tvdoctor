export class PreparedStateDivergenceError extends Error {
  constructor() {
    super("The prepared startup state could not be reproduced after reset.");
    this.name = "PreparedStateDivergenceError";
  }
}
