import { BuyerArt } from './BuyerAgent'
import { SellerArt } from './SellerAgent'
import { fragmentMono } from './ui'

/**
 * The closing card's room: the hero's two robots (blue buys, violet sells) standing on a lit floor, facing each
 * other, with an escrow lock between them and coins running both ways along the floor line. It is the sentence on
 * the card, drawn: two agents in a room, doing business. All vector and CSS, so it stays sharp at any size.
 */
export function CtaStage() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* back wall: a cool light from each side, so each robot has its own colour */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(55% 75% at 8% 100%, rgba(79,124,255,.34), transparent 70%), radial-gradient(55% 75% at 92% 100%, rgba(139,92,246,.34), transparent 70%), radial-gradient(50% 45% at 50% 0%, rgba(120,110,255,.12), transparent 75%)',
        }}
      />

      {/* floor: a grid in perspective that fades into the distance */}
      <div className="absolute inset-x-0 bottom-0 h-[34%] overflow-hidden" style={{ perspective: '420px' }}>
        <div
          className="absolute inset-x-[-40%] bottom-0 h-[220%] origin-bottom"
          style={{
            transform: 'rotateX(64deg)',
            backgroundImage:
              'linear-gradient(to right, rgba(130,150,255,.34) 1px, transparent 1px), linear-gradient(to bottom, rgba(130,150,255,.34) 1px, transparent 1px)',
            backgroundSize: '56px 56px',
            WebkitMaskImage: 'radial-gradient(60% 70% at 50% 100%, #000 20%, transparent 78%)',
            maskImage: 'radial-gradient(60% 70% at 50% 100%, #000 20%, transparent 78%)',
          }}
        />
      </div>

      {/* the floor line where the robots stand: blue on the buyer's side, violet on the seller's */}
      <div
        className="absolute inset-x-[4%] bottom-[13%] h-px"
        style={{ background: 'linear-gradient(90deg, transparent, #4F7CFF 18%, #A78BFA 50%, #8B5CF6 82%, transparent)' }}
      />
      <div
        className="absolute inset-x-[10%] bottom-[13%] h-6 -translate-y-1/2 opacity-60 blur-xl"
        style={{ background: 'linear-gradient(90deg, #4F7CFF, #8B5CF6)' }}
      />

      {/* coins: blue ones run buyer to seller, violet ones run back (the payment out, the result in) */}
      <div className="absolute inset-x-[22%] bottom-[13%] h-0">
        <span className="cta-coin cta-coin-right" style={{ animationDelay: '0s' }} />
        <span className="cta-coin cta-coin-right" style={{ animationDelay: '1.4s' }} />
        <span className="cta-coin cta-coin-left" style={{ animationDelay: '0.7s' }} />
        <span className="cta-coin cta-coin-left" style={{ animationDelay: '2.1s' }} />
      </div>

      {/* the escrow, in the middle of the floor line */}
      <div className="absolute bottom-[13%] left-1/2 flex -translate-x-1/2 translate-y-1/2 flex-col items-center gap-1.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-[#10122E]/90 shadow-[0_0_28px_rgba(139,124,255,.55)]">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#C9C2FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </span>
        <span className={`text-[10px] uppercase tracking-[0.2em] text-[#A3A5AE] ${fragmentMono.className}`}>escrow</span>
      </div>

      {/* the two agents, facing each other */}
      <div className="cta-bob absolute bottom-[12%] left-[2%] w-[clamp(92px,15vw,190px)]">
        <div
          className="absolute inset-x-[10%] -bottom-1 h-4 rounded-[50%] blur-md"
          style={{ background: 'radial-gradient(closest-side, rgba(79,124,255,.85), transparent)' }}
        />
        <BuyerArt className="relative block h-auto w-full overflow-visible" style={{ filter: 'drop-shadow(0 0 22px rgba(79,124,255,.4))' }} />
      </div>
      <div className="cta-bob absolute bottom-[12%] right-[2%] w-[clamp(92px,15vw,190px)]" style={{ animationDelay: '1.2s' }}>
        <div
          className="absolute inset-x-[10%] -bottom-1 h-4 rounded-[50%] blur-md"
          style={{ background: 'radial-gradient(closest-side, rgba(139,92,246,.85), transparent)' }}
        />
        <SellerArt className="relative block h-auto w-full overflow-visible" style={{ filter: 'drop-shadow(0 0 22px rgba(139,92,246,.4))' }} />
      </div>
    </div>
  )
}
