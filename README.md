# London Congestion Zone for Google Maps

A Chrome extension that draws the London Congestion Charge zone on Google Maps and tells you whether the charge is on right now.

## Why I built this

I drive a lot, and sometimes I want to take my car to uni. The catch is the Congestion Charge: go one street too far and that's £18 gone for the day. I just wanted to know how far into central I could get without paying it. Google Maps doesn't show the zone, so I built this.

## Install

1. Clone this repo, or use Code → Download ZIP and unzip it somewhere you'll keep it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder.
5. Open Google Maps, or reload it if it's already open.

Chrome runs the extension straight from this folder, so don't move or delete it.

## What it does

- Draws the zone boundary in red on google.com/maps and google.co.uk/maps, in both map and satellite view.
- Moves with the map when you drag. When you scroll to zoom it fades out and comes back once the map stops moving.
- Shows a badge in the top right when the zone is on screen, saying something like "Charging now · until 6pm" or "Not charging · starts 7am tomorrow". Hover over it to see the rules. The Hide/Show button turns the outline off and on, and it remembers your choice.
- Hides itself in Street View and tilted 3D view, because it can't line up properly there.

## Notes

- The boundary comes from OpenStreetMap (relation 3045928, © OpenStreetMap contributors, ODbL). It follows the inside edge of the boundary roads, since driving on those roads doesn't count.
- The charge is £18 a day (it went up from £15 on 2 Jan 2026). It applies 7am-6pm on weekdays and 12pm-6pm on weekends and bank holidays, and there's no charge from Christmas Day to the New Year's Day bank holiday. Bank holidays are worked out in code, so one-off extra ones won't be picked up. If TfL changes the rules, update `DAILY_CHARGE` and `chargingWindow` in `content.js`.
- Google Maps doesn't let extensions talk to its map, so this reads the position from the URL (the `@lat,lng,zoom` part). If Google changes how its URLs work, this will probably break.
