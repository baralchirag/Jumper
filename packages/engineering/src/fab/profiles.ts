// Capability presets for common fabs. Values are the standard-service minimums these fabs publish and
// are deliberately conservative; confirm against the fab's current capability page before ordering.
// Teams can define their own profile with the same shape.

export interface FabProfile {
  id: string;
  name: string;
  url: string;
  minTrackWidthMm: number;
  /** Copper-to-copper clearance, from DRC. */
  minClearanceMm: number;
  minViaDrillMm: number;
  minViaDiameterMm: number;
  minHoleDrillMm: number;
  minAnnularRingMm: number;
  maxCopperLayers: number;
  maxWidthMm: number;
  maxHeightMm: number;
  minWidthMm: number;
  minHeightMm: number;
  thicknessesMm: number[];
}

export const FAB_PROFILES: Record<string, FabProfile> = {
  jlcpcb: {
    id: 'jlcpcb', name: 'JLCPCB (standard)', url: 'https://jlcpcb.com/capabilities/pcb-capabilities',
    minTrackWidthMm: 0.127, minClearanceMm: 0.127, minViaDrillMm: 0.3, minViaDiameterMm: 0.5, minHoleDrillMm: 0.2, minAnnularRingMm: 0.13,
    maxCopperLayers: 20, maxWidthMm: 500, maxHeightMm: 400, minWidthMm: 5, minHeightMm: 5, thicknessesMm: [0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0],
  },
  pcbway: {
    id: 'pcbway', name: 'PCBWay (standard)', url: 'https://www.pcbway.com/capabilities.html',
    minTrackWidthMm: 0.1, minClearanceMm: 0.1, minViaDrillMm: 0.2, minViaDiameterMm: 0.4, minHoleDrillMm: 0.2, minAnnularRingMm: 0.1,
    maxCopperLayers: 32, maxWidthMm: 600, maxHeightMm: 1100, minWidthMm: 3, minHeightMm: 3, thicknessesMm: [0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0],
  },
  oshpark: {
    id: 'oshpark', name: 'OSH Park (2/4 layer)', url: 'https://docs.oshpark.com/design-tools/',
    minTrackWidthMm: 0.1524, minClearanceMm: 0.1524, minViaDrillMm: 0.254, minViaDiameterMm: 0.508, minHoleDrillMm: 0.254, minAnnularRingMm: 0.127,
    maxCopperLayers: 4, maxWidthMm: 500, maxHeightMm: 500, minWidthMm: 5, minHeightMm: 5, thicknessesMm: [1.6],
  },
  eurocircuits: {
    id: 'eurocircuits', name: 'Eurocircuits (6C classic)', url: 'https://www.eurocircuits.com/pcb-design-guidelines/',
    minTrackWidthMm: 0.15, minClearanceMm: 0.15, minViaDrillMm: 0.3, minViaDiameterMm: 0.6, minHoleDrillMm: 0.3, minAnnularRingMm: 0.15,
    maxCopperLayers: 16, maxWidthMm: 450, maxHeightMm: 550, minWidthMm: 10, minHeightMm: 10, thicknessesMm: [0.8, 1.0, 1.2, 1.55, 2.0],
  },
};

export const fabProfileIds = Object.keys(FAB_PROFILES);
