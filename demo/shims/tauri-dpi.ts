// Browser-demo shim for @tauri-apps/api/dpi.

export class LogicalSize {
  type = "Logical" as const;
  constructor(
    public width: number,
    public height: number,
  ) {}
}

export class PhysicalSize {
  type = "Physical" as const;
  constructor(
    public width: number,
    public height: number,
  ) {}
  toLogical(scale: number): LogicalSize {
    return new LogicalSize(this.width / scale, this.height / scale);
  }
}
