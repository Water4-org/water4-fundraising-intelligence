import { useState, useMemo } from 'react'
import { formatCurrency, classifyTier } from '../utils/tiers.js'
import { STAGES } from '../utils/api.js'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, RadarChart, Radar,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis, Cell,
} from 'recharts'

const TEAL = '#1B4D5C'
const GOLD = '#C4963E'

// Grants staff — included in the system but excluded from gift officer metrics
const GRANTS_STAFF = ['Matt Hangen', 'Wema Patience', 'Richard Moore']

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-gray-700 mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || p.fill }}>
          {p.name}: {typeof p.value === 'number' && p.value > 10
            ? formatCurrency(p.value, true)
            : p.value}
        </p>
      ))}
    </div>
  )
}

function StatCard({ label, value, sub, borderColor }) {
  return (
    <div className={`bg-white rounded-xl border p-4 ${borderColor || 'border-gray-200'}`}>
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-xl font-bold text-gray-800">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

/* ── Officer Detail Panel ── */
function OfficerDetail({ officer, donors, actions }) {
  const myDonors = useMemo(() => donors.filter(d => d.gift_officer === officer), [donors, officer])
  const myActions = useMemo(() => actions.filter(a => a.gift_officer === officer), [actions, officer])

  const stats = useMemo(() => {
    const thisFY = myDonors.reduce((s, d) => s + (d.giving_this_fy || 0), 0)
    const lastFY = myDonors.reduce((s, d) => s + (d.giving_last_fy || 0), 0)
    const yoyChange = lastFY > 0 ? ((thisFY - lastFY) / lastFY) * 100 : null

    const scores = myDonors.filter(d => d.ai_score != null).map(d => d.ai_score)
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null

    const pending = myActions.filter(a => a.status === 'pending').length
    const completed = myActions.filter(a => a.status === 'completed').length
    const completionRate = pending + completed > 0 ? (completed / (pending + completed)) * 100 : 0

    const highRisk = myDonors.filter(d => (d.lapse_risk || 0) >= 0.6).length
    const upgradeReady = myDonors.filter(d => (d.upgrade_propensity || 0) >= 0.6).length

    // Pipeline distribution
    const pipelineData = STAGES.map(stage => ({
      name: stage.replace('Identification and Qualification', 'ID & Qual').replace(' and ', ' & '),
      count: myDonors.filter(d => d.stage === stage).length,
    })).filter(s => s.count > 0)

    // Tier distribution
    const tierMap = {}
    for (const d of myDonors) {
      const tier = classifyTier(Math.max(d.giving_this_fy || 0, d.giving_last_fy || 0))
      if (!tierMap[tier.id]) tierMap[tier.id] = { name: tier.label, count: 0, value: 0, color: tier.color }
      tierMap[tier.id].count++
      tierMap[tier.id].value += d.giving_this_fy || 0
    }
    const tierData = Object.values(tierMap).sort((a, b) => b.value - a.value)

    // Radar metrics (normalized 0-100)
    const avgLapse = myDonors.length > 0
      ? myDonors.reduce((s, d) => s + (d.lapse_risk || 0), 0) / myDonors.length : 0
    const avgUpgrade = myDonors.length > 0
      ? myDonors.reduce((s, d) => s + (d.upgrade_propensity || 0), 0) / myDonors.length : 0
    const radarData = [
      { metric: 'Avg AI Score', value: avgScore || 0 },
      { metric: 'Retention', value: Math.round((1 - avgLapse) * 100) },
      { metric: 'Upgrade Pot.', value: Math.round(avgUpgrade * 100) },
      { metric: 'Completion', value: Math.round(completionRate) },
      { metric: 'Portfolio Size', value: Math.min(myDonors.length, 100) },
    ]

    // Top donors by this FY
    const topDonors = [...myDonors]
      .sort((a, b) => (b.giving_this_fy || 0) - (a.giving_this_fy || 0))
      .slice(0, 10)

    return {
      thisFY, lastFY, yoyChange, avgScore,
      pending, completed, completionRate,
      highRisk, upgradeReady,
      pipelineData, tierData, radarData, topDonors,
      totalDonors: myDonors.length,
    }
  }, [myDonors, myActions])

  return (
    <div className="space-y-5 mt-4">
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <StatCard label="Portfolio Size" value={stats.totalDonors} sub="donors" />
        <StatCard
          label="This FY Revenue"
          value={formatCurrency(stats.thisFY, true)}
          sub={stats.yoyChange != null ? `${stats.yoyChange >= 0 ? '+' : ''}${stats.yoyChange.toFixed(1)}% YoY` : null}
        />
        <StatCard label="Avg AI Score" value={stats.avgScore ?? '—'} />
        <StatCard
          label="Action Completion"
          value={`${stats.completionRate.toFixed(0)}%`}
          sub={`${stats.completed} done / ${stats.pending} pending`}
        />
        <StatCard label="Lapse Risk" value={stats.highRisk} sub="donors at ≥60%" borderColor="border-red-200" />
        <StatCard label="Upgrade Ready" value={stats.upgradeReady} sub="donors at ≥60%" borderColor="border-emerald-200" />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* Performance Radar */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Performance Profile</h4>
          <ResponsiveContainer width="100%" height={220}>
            <RadarChart data={stats.radarData}>
              <PolarGrid stroke="#e5e7eb" />
              <PolarAngleAxis dataKey="metric" tick={{ fontSize: 10, fill: '#6b7280' }} />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              <Radar dataKey="value" stroke={TEAL} fill={TEAL} fillOpacity={0.25} strokeWidth={2} />
            </RadarChart>
          </ResponsiveContainer>
        </div>

        {/* Pipeline Distribution */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Pipeline Distribution</h4>
          {stats.pipelineData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.pipelineData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={80} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="count" name="Donors" fill={TEAL} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-gray-400 mt-8 text-center">No pipeline data</p>
          )}
        </div>

        {/* Tier Distribution */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Tier Distribution</h4>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stats.tierData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="count" name="Donors" radius={[4, 4, 0, 0]}>
                {stats.tierData.map((t, i) => <Cell key={i} fill={t.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top donors table */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Top Donors</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Donor</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Tier</th>
                <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase">This FY</th>
                <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Last FY</th>
                <th className="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">AI Score</th>
                <th className="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Lapse Risk</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Stage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {stats.topDonors.map(d => {
                const tier = classifyTier(Math.max(d.giving_this_fy || 0, d.giving_last_fy || 0))
                return (
                  <tr key={d.sf_id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-800">{d.full_name}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${tier.bg} ${tier.text} ${tier.border}`}>
                        {tier.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-800">{formatCurrency(d.giving_this_fy, true)}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-500">{formatCurrency(d.giving_last_fy, true)}</td>
                    <td className="px-4 py-2 text-center">
                      {d.ai_score != null ? (
                        <span className={`text-xs font-bold ${d.ai_score >= 70 ? 'text-emerald-600' : d.ai_score >= 50 ? 'text-amber-600' : 'text-red-500'}`}>
                          {Math.round(d.ai_score)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {d.lapse_risk != null ? (
                        <span className={`text-xs font-bold ${d.lapse_risk >= 0.6 ? 'text-red-500' : d.lapse_risk >= 0.3 ? 'text-amber-600' : 'text-emerald-600'}`}>
                          {(d.lapse_risk * 100).toFixed(0)}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">{d.stage || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ── Main Officers View ── */
export default function OfficersView({ donors, campaigns, actions }) {
  const [selectedOfficer, setSelectedOfficer] = useState(null)

  const officers = useMemo(() => {
    const map = {}
    for (const d of donors) {
      const o = d.gift_officer || 'Unassigned'
      if (GRANTS_STAFF.includes(o)) continue
      if (!map[o]) map[o] = { name: o, donors: 0, thisFY: 0, lastFY: 0, scores: [], pendingActions: 0, completedActions: 0, highRisk: 0, upgradeReady: 0 }
      map[o].donors++
      map[o].thisFY += d.giving_this_fy || 0
      map[o].lastFY += d.giving_last_fy || 0
      if (d.ai_score != null) map[o].scores.push(d.ai_score)
      if ((d.lapse_risk || 0) >= 0.6) map[o].highRisk++
      if ((d.upgrade_propensity || 0) >= 0.6) map[o].upgradeReady++
    }
    for (const a of actions) {
      const o = a.gift_officer || 'Unassigned'
      if (map[o]) {
        if (a.status === 'pending') map[o].pendingActions++
        if (a.status === 'completed') map[o].completedActions++
      }
    }
    return Object.values(map).map(o => ({
      ...o,
      avgScore: o.scores.length > 0 ? Math.round(o.scores.reduce((s, x) => s + x, 0) / o.scores.length) : null,
      completionRate: o.pendingActions + o.completedActions > 0
        ? Math.round((o.completedActions / (o.pendingActions + o.completedActions)) * 100) : null,
    })).sort((a, b) => b.thisFY - a.thisFY)
  }, [donors, actions])

  // Summary stats
  const totalRevenue = officers.reduce((s, o) => s + o.thisFY, 0)
  const totalDonors = officers.reduce((s, o) => s + o.donors, 0)
  const avgPerOfficer = officers.length > 0 ? totalRevenue / officers.length : 0

  // Chart data: revenue by officer
  const revenueData = officers.filter(o => o.name !== 'Unassigned').slice(0, 15)

  return (
    <div className="space-y-6">
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Gift Officers" value={officers.filter(o => o.name !== 'Unassigned').length} />
        <StatCard label="Total Donors" value={totalDonors} />
        <StatCard label="Total Revenue" value={formatCurrency(totalRevenue, true)} />
        <StatCard label="Avg per Officer" value={formatCurrency(avgPerOfficer, true)} />
      </div>

      {/* Revenue by officer chart */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Revenue by Officer</h3>
        <ResponsiveContainer width="100%" height={Math.max(250, revenueData.length * 36)}>
          <BarChart data={revenueData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tickFormatter={v => formatCurrency(v, true)} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={130} />
            <Tooltip content={<ChartTooltip />} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="thisFY" name="This FY" fill={TEAL} radius={[0, 4, 4, 0]} />
            <Bar dataKey="lastFY" name="Last FY" fill="#D1D5DB" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Officer table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Officer</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Portfolio</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">This FY</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Last FY</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Avg Score</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Completion</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Pending</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">At Risk</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Upgrade</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {officers.map(o => {
              const isSelected = selectedOfficer === o.name
              const yoy = o.lastFY > 0 ? ((o.thisFY - o.lastFY) / o.lastFY) * 100 : null
              return [
                <tr
                  key={o.name}
                  className={`cursor-pointer transition-colors ${isSelected ? 'bg-teal/5' : 'hover:bg-gray-50'}`}
                  onClick={() => setSelectedOfficer(isSelected ? null : o.name)}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${isSelected ? 'text-teal' : 'text-gray-400'}`}>{isSelected ? '▼' : '▶'}</span>
                      <span className="font-medium text-gray-800">{o.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{o.donors}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-mono text-gray-800">{formatCurrency(o.thisFY, true)}</span>
                    {yoy != null && (
                      <span className={`ml-1.5 text-xs font-medium ${yoy >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        {yoy >= 0 ? '▲' : '▼'}{Math.abs(yoy).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-500">{formatCurrency(o.lastFY, true)}</td>
                  <td className="px-4 py-3 text-center">
                    {o.avgScore != null ? (
                      <span className={`text-xs font-bold ${o.avgScore >= 70 ? 'text-emerald-600' : o.avgScore >= 50 ? 'text-amber-600' : 'text-red-500'}`}>
                        {o.avgScore}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {o.completionRate != null ? (
                      <span className={`text-xs font-bold ${o.completionRate >= 70 ? 'text-emerald-600' : o.completionRate >= 40 ? 'text-amber-600' : 'text-red-500'}`}>
                        {o.completionRate}%
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {o.pendingActions > 0 ? (
                      <span className="bg-amber-100 text-amber-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                        {o.pendingActions}
                      </span>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {o.highRisk > 0 ? (
                      <span className="bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                        {o.highRisk}
                      </span>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {o.upgradeReady > 0 ? (
                      <span className="bg-emerald-100 text-emerald-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                        {o.upgradeReady}
                      </span>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                </tr>,
                isSelected && (
                  <tr key={`${o.name}-detail`}>
                    <td colSpan={9} className="px-4 py-2 bg-gray-50/50">
                      <OfficerDetail officer={o.name} donors={donors} actions={actions} />
                    </td>
                  </tr>
                ),
              ]
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
