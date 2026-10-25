import { useEffect, useState } from 'react'
import { api } from '../api'
import { Btn, Info, Toggle } from './ui'

type Status = { available: boolean; reason: string | null; email: string; hasPassword: boolean; sites: Array<{ origin: string; login: boolean; registration: boolean }> }
type Props = { onToast: (message: string, kind?: 'info' | 'warn' | 'error' | 'ok') => void }

export default function SiteAccounts({ onToast }: Props) {
  const [status, setStatus] = useState<Status | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [origin, setOrigin] = useState('')
  const [registration, setRegistration] = useState(false)
  const [working, setWorking] = useState(false)
  useEffect(() => {
    let alive = true
    api.siteAccountsStatus().then((value) => { if (alive && value) { setStatus(value); setEmail(value.email) } })
    return () => { alive = false }
  }, [])
  const run = async (action: () => Promise<Status | null>, message: string) => {
    setWorking(true)
    try {
      const value = await action()
      if (value) { setStatus(value); setEmail(value.email); onToast(message, 'ok'); return true }
      return false
    } finally { setWorking(false) }
  }
  return <section className="set-section">
    <div className="label">Site hesapları</div>
    <div className="set-row">
      <div className="set-key"><span className="info-wrap">E-posta ve parola<Info label="Site hesapları hakkında">Bilgiler bu cihazın sistem anahtarlığıyla şifrelenir. Yalnız aşağıda izin verdiğin HTTPS sitelerinde kullanılır; alt alan adları ayrıca eklenir. Kitaplık yedeği bu parolayı içermez.</Info></span></div>
      <div className="set-control">
        <div className="set-hint">Üyelik isteyen sitelerde aynı hesap bilgilerini kullan. Kayıt, girişten ayrı olarak site başına açılır.</div>
        {status?.reason ? <div className="set-hint" role="status">{status.reason}</div> : null}
        <div className="set-inline" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <input className="input" type="email" name="site-account-email" autoComplete="email" spellCheck={false} aria-label="Site hesabı e-posta adresi" placeholder="E-posta adresin" value={email} disabled={working || status?.available === false} onChange={(event) => setEmail(event.target.value)} />
          <input className="input" type="password" name="site-account-password" autoComplete="new-password" aria-label="Site hesabı parolası" placeholder={status?.hasPassword ? 'Kayıtlı parola korunur' : 'En az 8 karakter'} value={password} disabled={working || status?.available === false} onChange={(event) => setPassword(event.target.value)} />
          <Btn size="sm" disabled={!status?.available || working || !email.trim() || !password && !status.hasPassword} spinning={working} onClick={async () => { const secret = password; setPassword(''); await run(() => api.saveSiteAccountProfile({ email, password: secret }), 'Hesap bilgileri güvenli biçimde kaydedildi.') }}>Kaydet</Btn>
          {status?.hasPassword || status?.reason ? <Btn size="sm" variant="ghost" disabled={working} onClick={() => { setPassword(''); run(() => api.clearSiteAccountProfile(), 'Kayıtlı hesap bilgileri ve site izinleri silindi.') }}>Bilgileri sil</Btn> : null}
        </div>
        {status?.hasPassword ? <div className="set-hint" role="status">Parola kayıtlı. Değiştirmeyeceksen parola alanını boş bırak.</div> : null}
      </div>
    </div>
    <div className="set-row">
      <div className="set-key">İzin verilen siteler</div>
      <div className="set-control">
        <div className="set-inline" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input className="input" type="url" autoComplete="url" spellCheck={false} aria-label="İzin verilecek HTTPS site adresi" placeholder="https://www.ornek.com" value={origin} disabled={working || !status?.hasPassword} onChange={(event) => setOrigin(event.target.value)} />
          <Btn size="sm" icon="plus" disabled={working || !status?.hasPassword || !origin.trim()} onClick={async () => { if (await run(() => api.setSiteAccountPolicy({ origin, login: true, registration }), 'Site izni kaydedildi. Kaynağı yeniden tarayabilirsin.')) setOrigin('') }}>Site ekle</Btn>
        </div>
        <div style={{ marginTop: 10 }}><Toggle checked={registration} disabled={working || !status?.hasPassword} onChange={setRegistration} label="Eklediğim sitede otomatik kayda da izin ver" /></div>
        <div className="set-hint">Giriş ve kayıt gerektiğinde sitedeki ilgili sayfa açılır; standart e-posta ve parola formları denenir. CAPTCHA, e-posta kodu, üyelik koşulları veya ek kişisel bilgi gerekirse tarayıcıda tamamlaman istenir.</div>
        {status?.sites.map((site) => <div key={site.origin} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 14 }}>
          <span className="truncate" style={{ flex: '1 1 180px' }} title={site.origin}>{site.origin}</span>
          <Toggle checked={site.login} disabled={working} onChange={(login) => run(() => api.setSiteAccountPolicy({ ...site, login, registration: login && site.registration }), 'Site giriş izni güncellendi.')} label="Giriş" />
          <Toggle checked={site.registration} disabled={working} onChange={(allow) => run(() => api.setSiteAccountPolicy({ ...site, login: allow || site.login, registration: allow }), 'Site kayıt izni güncellendi.')} label="Kayıt" />
          <Btn size="sm" variant="ghost" disabled={working} onClick={() => run(() => api.removeSiteAccountPolicy(site.origin), 'Site izni kaldırıldı.')}>Kaldır</Btn>
        </div>)}
      </div>
    </div>
  </section>
}
