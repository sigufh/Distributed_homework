class SnowflakeIdGenerator {
  constructor(workerId) {
    this.epoch = BigInt(1704067200000);
    this.workerIdBits = BigInt(10);
    this.sequenceBits = BigInt(12);
    this.maxWorkerId = (1n << this.workerIdBits) - 1n;
    this.maxSequence = (1n << this.sequenceBits) - 1n;
    this.workerId = BigInt(workerId) & this.maxWorkerId;
    this.lastTimestamp = -1n;
    this.sequence = 0n;
  }
  currentMillis() { return BigInt(Date.now()); }
  waitNextMillis(lastTs) { let ts = this.currentMillis(); while (ts <= lastTs) { ts = this.currentMillis(); } return ts; }
  nextId() {
    let ts = this.currentMillis();
    if (ts < this.lastTimestamp) { ts = this.lastTimestamp; }
    if (ts === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & this.maxSequence;
      if (this.sequence === 0n) { ts = this.waitNextMillis(this.lastTimestamp); }
    } else { this.sequence = 0n; }
    this.lastTimestamp = ts;
    const timePart = (ts - this.epoch) << (this.workerIdBits + this.sequenceBits);
    const workerPart = this.workerId << this.sequenceBits;
    const id = timePart | workerPart | this.sequence;
    return id.toString();
  }
}

function createIdGenerator(workerId) { return new SnowflakeIdGenerator(workerId); }

module.exports = { SnowflakeIdGenerator, createIdGenerator };
