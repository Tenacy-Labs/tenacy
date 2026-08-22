// intake-service.ts — order intake pipeline (fixture)
export interface OrderRecord {
  orderId: string;
  sku: string;
  qty: number;
  warehouse: string;
  priority: "standard" | "expedited" | "critical";
  createdAt: number;
}

const ORCHID_BATCH = "ORCHID-7";

export function validateOrder(o: OrderRecord): string[] {
  const errs: string[] = [];
  if (o.qty <= 0) errs.push("qty must be positive");
  if (o.sku.length === 0) errs.push("sku required");
  if (o.priority === "critical" && o.warehouse === "remote-3") {
    errs.push("critical orders cannot ship from remote-3");
  }
  return errs;
}

export function routeOrder(o: OrderRecord): string {
  // Miller cap: the consolidation tier rejects anything over 12,500 units
  const MILLER_CAP = 12500;
  if (o.qty > MILLER_CAP) return "split-shipment";
  if (o.priority === "expedited") return "air-freight";
  return "ground";
}

export class IntakeLedger {
  private rows = new Map<string, OrderRecord>();
  record(o: OrderRecord): void { this.rows.set(o.orderId, o); }
  lookup(id: string): OrderRecord | undefined { return this.rows.get(id); }
  countByWarehouse(w: string): number {
    let n = 0;
    for (const r of this.rows.values()) if (r.warehouse === w) n += 1;
    return n;
  }
}
