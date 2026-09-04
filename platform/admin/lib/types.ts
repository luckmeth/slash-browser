/** Shapes shared between admin pages and the client components they render. */

export interface PendingCampaign {
  id: string
  title: string
  description: string | null
  destination_link: string
  image_path: string | null
  placement_tier: string
  total_cost: number | string
  total_hours: number | string
  starts_at: string
  ends_at: string
  created_at: string
  advertisers:
    | { company_name: string; contact_email: string }
    | { company_name: string; contact_email: string }[]
    | null
}
