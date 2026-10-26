export type AudioChoice = 'en' | 'tr' | 'auto' | 'original'
export default function AudioSelect({ value, onChange, title = 'İndirilecek ses dili' }: {
  value: AudioChoice; onChange: (value: AudioChoice) => void; title?: string
}) {
  return <select className="select" value={value} title={title} aria-label={title} onChange={(event) => onChange(event.target.value as AudioChoice)}>
    <option value="tr">Türkçe ses</option>
    <option value="en">İngilizce ses</option>
    <option value="original">Orijinal ses</option>
    <option value="auto">Kaynağın varsayılan sesi</option>
  </select>
}
