-- Ad formats, priced by how much of the screen they take.
--
-- The rate ladder is deliberate: it tracks *attention*, which is roughly screen
-- share for the start-page formats and something else entirely for the notice.

insert into pricing_config
  (placement_tier, display_name, description, hourly_rate, min_hours, max_concurrent)
values
  -- Whole backdrop. Nothing else competes with it.
  ('newtab_background', 'Full start page', 'Your image as the entire backdrop of the new-tab page, with your headline over it.',
   12.00, 24, 1),

  -- A strip across the start page. Visible without owning the page.
  ('newtab_banner', 'Start page banner', 'A wide panel across the start page, with your image, headline and supporting line.',
   6.00, 24, 2),

  -- The first tile position.
  ('newtab_feature', 'Featured tile', 'The first tile on the start page, shown ahead of the rotation.',
   4.00, 24, 2),

  -- One of several small tiles.
  ('home_banner', 'Standard tile', 'A clearly-labelled tile in the start page rotation.',
   2.50, 24, 6),

  -- The most valuable and the most intrusive, which is why it is the dearest
  -- AND the rarest. It appears in the browser's own chrome while somebody
  -- browses -- never inside a web page, because injecting adverts into pages is
  -- the exact behaviour this browser blocks, and doing it ourselves would make
  -- the product adware.
  ('browser_notice', 'Browsing notice', 'A small, dismissible notice from the browser itself while somebody is browsing. Never inside a web page. Shown at most a few times a day per person.',
   18.00, 24, 1)
on conflict (placement_tier) do update set
  display_name = excluded.display_name,
  description  = excluded.description;

-- Rates are only seeded for tiers that did not already exist. An operator who
-- has changed a price must not have it silently reset by a migration.
update pricing_config set hourly_rate = 6.00, min_hours = 24, max_concurrent = 2
 where placement_tier = 'newtab_banner' and hourly_rate = 0;
update pricing_config set hourly_rate = 18.00, min_hours = 24, max_concurrent = 1
 where placement_tier = 'browser_notice' and hourly_rate = 0;
