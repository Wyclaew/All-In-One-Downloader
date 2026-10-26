'use strict'
// A master's audio/subtitle renditions belong to that video, not to additional
// video rows. Match complete URLs and source ids; unrelated audio remains valid.
function withoutRenditionRows(items) {
  const children = new Set()
  for (const item of items) {
    if (item.resolved?.kind !== 'hls' || !(item.height || item.variants?.length)) continue
    for (const track of [...(item.audioTracks || []), ...(item.subtitles || [])]) {
      if (track.url && track.url !== item.url) children.add(`${item.sourceId}\n${track.url.split('#')[0]}`)
    }
  }
  return items.filter((item) => !children.has(`${item.sourceId}\n${item.url?.split('#')[0]}`))
}
module.exports = { withoutRenditionRows }
