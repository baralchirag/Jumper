// Public facts about this Jumper instance (GET /api/site).

export interface SiteInfo {
  name: string;
  publicUrl: string;
  operator: {
    /** Legal name of whoever runs this instance; null until the operator sets OPERATOR_NAME. */
    name: string | null;
    email: string | null;
    jurisdiction: string | null;
  };
  /** YYYY-MM-DD the legal pages last changed, or null. */
  legalUpdated: string | null;
  signup: boolean;
}

/** Each fab's own upload page. */
export const FAB_ORDER_PAGES = {
  jlcpcb: 'https://cart.jlcpcb.com/quote',
  pcbway: 'https://www.pcbway.com/QuickOrderOnline.aspx',
  oshpark: 'https://oshpark.com/',
} as const;
