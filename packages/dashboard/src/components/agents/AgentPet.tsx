import { useState } from 'react';
import type { ReactElement } from 'react';
import { cn } from '../../lib/utils';

type PetType = 'cat' | 'hamster' | 'fox' | 'ladybug' | 'octopus' | 'owl' | 'shiba' | 'bee' | 'rabbit';
type PetStatus = 'idle' | 'working' | 'error' | 'offline';

const roleToPet: Record<string, PetType> = {
  orchestrator: 'cat',
  developer: 'hamster',
  designer: 'fox',
  tester: 'ladybug',
  devops: 'octopus',
  reviewer: 'owl',
  'product-manager': 'shiba',
  'content-writer': 'bee',
};

// SVG pets - simple cute pixel-style animals
const petSvgs: Record<PetType, (status: PetStatus, petted: boolean) => ReactElement> = {
  cat: (status, petted) => (
    <svg viewBox="0 0 48 48" className="w-full h-full">
      {/* Ears */}
      <polygon points="12,18 16,8 20,18" fill="#6b7280" />
      <polygon points="28,18 32,8 36,18" fill="#6b7280" />
      {/* Body */}
      <ellipse cx="24" cy="30" rx="12" ry="10" fill="#9ca3af" />
      {/* Face */}
      <circle cx="24" cy="22" r="10" fill="#9ca3af" />
      {/* Eyes */}
      {status === 'idle' ? (
        <>
          <path d="M19,21 Q21,23 23,21" fill="none" stroke="#1f2937" strokeWidth="1.5" />
          <path d="M25,21 Q27,23 29,21" fill="none" stroke="#1f2937" strokeWidth="1.5" />
        </>
      ) : status === 'error' ? (
        <>
          <text x="18" y="23" fontSize="6" fill="#1f2937">×</text>
          <text x="26" y="23" fontSize="6" fill="#1f2937">×</text>
        </>
      ) : (
        <>
          <circle cx="20" cy="21" r="2" fill="#1f2937" />
          <circle cx="28" cy="21" r="2" fill="#1f2937" />
        </>
      )}
      {/* Mouth */}
      <path d="M22,26 Q24,28 26,26" fill="none" stroke="#1f2937" strokeWidth="1" />
      {/* Tail */}
      <path
        d="M36,30 Q42,25 40,20"
        fill="none"
        stroke="#9ca3af"
        strokeWidth="3"
        strokeLinecap="round"
        className={cn(status === 'working' && 'animate-wag', petted && 'animate-wag')}
      />
      {/* Heart when petted */}
      {petted && <text x="34" y="12" fontSize="8" className="animate-float">❤️</text>}
      {/* Zzz when idle */}
      {status === 'idle' && <text x="32" y="14" fontSize="7" className="animate-pulse opacity-60">💤</text>}
      {/* Sweat when error */}
      {status === 'error' && <text x="32" y="14" fontSize="7">💦</text>}
    </svg>
  ),
  hamster: (status, petted) => (
    <svg viewBox="0 0 48 48" className="w-full h-full">
      {/* Ears */}
      <circle cx="14" cy="14" r="5" fill="#f59e0b" />
      <circle cx="34" cy="14" r="5" fill="#f59e0b" />
      {/* Body */}
      <ellipse cx="24" cy="32" rx="10" ry="9" fill="#fbbf24" />
      {/* Face */}
      <circle cx="24" cy="22" r="11" fill="#fbbf24" />
      {/* Cheeks */}
      <circle cx="16" cy="25" r="4" fill="#fcd34d" opacity="0.7" />
      <circle cx="32" cy="25" r="4" fill="#fcd34d" opacity="0.7" />
      {/* Eyes */}
      {status === 'idle' ? (
        <>
          <path d="M19,20 Q21,22 23,20" fill="none" stroke="#1f2937" strokeWidth="1.5" />
          <path d="M25,20 Q27,22 29,20" fill="none" stroke="#1f2937" strokeWidth="1.5" />
        </>
      ) : (
        <>
          <circle cx="20" cy="20" r="2.5" fill="#1f2937" />
          <circle cx="28" cy="20" r="2.5" fill="#1f2937" />
          <circle cx="21" cy="19" r="1" fill="white" />
          <circle cx="29" cy="19" r="1" fill="white" />
        </>
      )}
      {/* Nose & mouth */}
      <circle cx="24" cy="24" r="1.5" fill="#92400e" />
      <path d="M22,26 Q24,27 26,26" fill="none" stroke="#92400e" strokeWidth="0.8" />
      {petted && <text x="34" y="10" fontSize="8" className="animate-float">❤️</text>}
      {status === 'idle' && <text x="32" y="12" fontSize="7" className="animate-pulse opacity-60">💤</text>}
      {status === 'working' && <text x="34" y="10" fontSize="6" className="animate-bounce">⌨️</text>}
      {status === 'error' && <text x="32" y="12" fontSize="7">😵</text>}
    </svg>
  ),
  fox: (status, petted) => (
    <svg viewBox="0 0 48 48" className="w-full h-full">
      {/* Ears */}
      <polygon points="10,20 15,6 20,18" fill="#ea580c" />
      <polygon points="28,18 33,6 38,20" fill="#ea580c" />
      <polygon points="13,18 15,10 18,17" fill="#fef3c7" />
      <polygon points="30,17 33,10 35,18" fill="#fef3c7" />
      {/* Face */}
      <circle cx="24" cy="24" r="11" fill="#f97316" />
      {/* White muzzle */}
      <ellipse cx="24" cy="28" rx="6" ry="5" fill="white" />
      {/* Body */}
      <ellipse cx="24" cy="36" rx="8" ry="6" fill="#f97316" />
      {/* Eyes */}
      {status === 'idle' ? (
        <>
          <path d="M18,22 L22,22" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
          <path d="M26,22 L30,22" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <ellipse cx="20" cy="22" rx="2" ry="2.5" fill="#1f2937" />
          <ellipse cx="28" cy="22" rx="2" ry="2.5" fill="#1f2937" />
        </>
      )}
      {/* Nose */}
      <circle cx="24" cy="26" r="2" fill="#1f2937" />
      {/* Tail */}
      <path d="M34,34 Q42,30 40,24" fill="none" stroke="#f97316" strokeWidth="4" strokeLinecap="round"
        className={cn(petted && 'animate-wag')} />
      {petted && <text x="34" y="10" fontSize="8" className="animate-float">❤️</text>}
      {status === 'idle' && <text x="32" y="12" fontSize="7" className="animate-pulse opacity-60">💤</text>}
      {status === 'error' && <text x="32" y="12" fontSize="7">💦</text>}
    </svg>
  ),
  ladybug: (status, petted) => (
    <svg viewBox="0 0 48 48" className="w-full h-full">
      {/* Body */}
      <circle cx="24" cy="26" r="13" fill="#dc2626" />
      {/* Line down middle */}
      <line x1="24" y1="13" x2="24" y2="39" stroke="#1f2937" strokeWidth="1.5" />
      {/* Spots */}
      <circle cx="18" cy="22" r="2.5" fill="#1f2937" />
      <circle cx="30" cy="22" r="2.5" fill="#1f2937" />
      <circle cx="19" cy="31" r="2" fill="#1f2937" />
      <circle cx="29" cy="31" r="2" fill="#1f2937" />
      {/* Head */}
      <circle cx="24" cy="15" r="6" fill="#1f2937" />
      {/* Eyes */}
      <circle cx="22" cy="14" r="2" fill="white" />
      <circle cx="26" cy="14" r="2" fill="white" />
      <circle cx="22" cy="14" r="1" fill="#1f2937" />
      <circle cx="26" cy="14" r="1" fill="#1f2937" />
      {/* Antennae */}
      <path d="M21,10 Q19,5 17,4" fill="none" stroke="#1f2937" strokeWidth="1.5" strokeLinecap="round"
        className={cn(status === 'working' && 'animate-wiggle')} />
      <path d="M27,10 Q29,5 31,4" fill="none" stroke="#1f2937" strokeWidth="1.5" strokeLinecap="round"
        className={cn(status === 'working' && 'animate-wiggle')} />
      {petted && <text x="34" y="8" fontSize="8" className="animate-float">❤️</text>}
      {status === 'idle' && <text x="32" y="10" fontSize="7" className="animate-pulse opacity-60">💤</text>}
    </svg>
  ),
  octopus: (status, petted) => (
    <svg viewBox="0 0 48 48" className="w-full h-full">
      {/* Head */}
      <ellipse cx="24" cy="18" rx="12" ry="11" fill="#8b5cf6" />
      {/* Eyes */}
      {status === 'idle' ? (
        <>
          <path d="M18,17 Q20,19 22,17" fill="none" stroke="white" strokeWidth="1.5" />
          <path d="M26,17 Q28,19 30,17" fill="none" stroke="white" strokeWidth="1.5" />
        </>
      ) : (
        <>
          <circle cx="20" cy="17" r="3" fill="white" />
          <circle cx="28" cy="17" r="3" fill="white" />
          <circle cx="20" cy="17" r="1.5" fill="#1f2937" />
          <circle cx="28" cy="17" r="1.5" fill="#1f2937" />
        </>
      )}
      {/* Mouth */}
      <path d="M21,22 Q24,24 27,22" fill="none" stroke="#c4b5fd" strokeWidth="1" />
      {/* Tentacles */}
      <path d="M13,28 Q10,34 12,40" fill="none" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round"
        className={cn(status === 'working' && 'animate-wiggle')} />
      <path d="M18,30 Q16,36 18,42" fill="none" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round"
        className={cn(status === 'working' && 'animate-wiggle [animation-delay:100ms]')} />
      <path d="M24,31 Q24,37 24,43" fill="none" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M30,30 Q32,36 30,42" fill="none" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round"
        className={cn(status === 'working' && 'animate-wiggle [animation-delay:200ms]')} />
      <path d="M35,28 Q38,34 36,40" fill="none" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round"
        className={cn(status === 'working' && 'animate-wiggle [animation-delay:300ms]')} />
      {petted && <text x="34" y="8" fontSize="8" className="animate-float">❤️</text>}
      {status === 'idle' && <text x="32" y="8" fontSize="7" className="animate-pulse opacity-60">💤</text>}
    </svg>
  ),
  owl: (status, petted) => (
    <svg viewBox="0 0 48 48" className="w-full h-full">
      {/* Ear tufts */}
      <polygon points="12,14 15,4 18,14" fill="#92400e" />
      <polygon points="30,14 33,4 36,14" fill="#92400e" />
      {/* Body */}
      <ellipse cx="24" cy="30" rx="11" ry="12" fill="#a16207" />
      {/* Belly */}
      <ellipse cx="24" cy="33" rx="7" ry="8" fill="#fef3c7" />
      {/* Face */}
      <circle cx="24" cy="20" r="11" fill="#ca8a04" />
      {/* Eye circles */}
      <circle cx="19" cy="19" r="5" fill="white" />
      <circle cx="29" cy="19" r="5" fill="white" />
      {/* Pupils */}
      {status === 'idle' ? (
        <>
          <path d="M17,19 L21,19" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
          <path d="M27,19 L31,19" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="19" cy="19" r="2.5" fill="#1f2937" />
          <circle cx="29" cy="19" r="2.5" fill="#1f2937" />
        </>
      )}
      {/* Beak */}
      <polygon points="22,23 24,27 26,23" fill="#f59e0b" />
      {petted && <text x="34" y="8" fontSize="8" className="animate-float">❤️</text>}
      {status === 'idle' && <text x="34" y="10" fontSize="7" className="animate-pulse opacity-60">💤</text>}
      {status === 'working' && <text x="4" y="10" fontSize="6">🔍</text>}
    </svg>
  ),
  shiba: (status, petted) => (
    <svg viewBox="0 0 48 48" className="w-full h-full">
      {/* Ears */}
      <polygon points="10,18 15,6 20,16" fill="#d97706" />
      <polygon points="28,16 33,6 38,18" fill="#d97706" />
      {/* Face */}
      <circle cx="24" cy="24" r="12" fill="#f59e0b" />
      {/* White face markings */}
      <ellipse cx="24" cy="28" rx="8" ry="7" fill="#fef9c3" />
      {/* Body */}
      <ellipse cx="24" cy="38" rx="9" ry="6" fill="#f59e0b" />
      {/* Eyes */}
      {status === 'idle' ? (
        <>
          <path d="M18,22 Q20,24 22,22" fill="none" stroke="#1f2937" strokeWidth="1.5" />
          <path d="M26,22 Q28,24 30,22" fill="none" stroke="#1f2937" strokeWidth="1.5" />
        </>
      ) : (
        <>
          <circle cx="20" cy="22" r="2" fill="#1f2937" />
          <circle cx="28" cy="22" r="2" fill="#1f2937" />
        </>
      )}
      {/* Nose */}
      <ellipse cx="24" cy="26" rx="2.5" ry="2" fill="#1f2937" />
      {/* Mouth */}
      <path d="M22,28 Q24,30 26,28" fill="none" stroke="#1f2937" strokeWidth="1" />
      {/* Tail */}
      <path d="M34,36 Q40,32 38,26" fill="none" stroke="#f59e0b" strokeWidth="4" strokeLinecap="round"
        className={cn((status === 'working' || petted) && 'animate-wag')} />
      {petted && <text x="34" y="8" fontSize="8" className="animate-float">❤️</text>}
      {status === 'idle' && <text x="34" y="10" fontSize="7" className="animate-pulse opacity-60">💤</text>}
      {status === 'error' && <text x="34" y="10" fontSize="7">🥺</text>}
    </svg>
  ),
  bee: (status, petted) => (
    <svg viewBox="0 0 48 48" className="w-full h-full">
      {/* Wings */}
      <ellipse cx="16" cy="18" rx="6" ry="8" fill="#bfdbfe" opacity="0.6"
        className={cn(status === 'working' && 'animate-flutter')} />
      <ellipse cx="32" cy="18" rx="6" ry="8" fill="#bfdbfe" opacity="0.6"
        className={cn(status === 'working' && 'animate-flutter')} />
      {/* Body */}
      <ellipse cx="24" cy="26" rx="9" ry="12" fill="#fbbf24" />
      {/* Stripes */}
      <rect x="15" y="22" width="18" height="3" fill="#1f2937" rx="1" />
      <rect x="15" y="28" width="18" height="3" fill="#1f2937" rx="1" />
      <rect x="16" y="34" width="16" height="3" fill="#1f2937" rx="1" />
      {/* Face */}
      <circle cx="24" cy="17" r="7" fill="#fbbf24" />
      {/* Eyes */}
      {status === 'idle' ? (
        <>
          <path d="M20,16 Q22,18 24,16" fill="none" stroke="#1f2937" strokeWidth="1.2" />
          <path d="M24,16 Q26,18 28,16" fill="none" stroke="#1f2937" strokeWidth="1.2" />
        </>
      ) : (
        <>
          <circle cx="21" cy="16" r="2" fill="#1f2937" />
          <circle cx="27" cy="16" r="2" fill="#1f2937" />
        </>
      )}
      {/* Antennae */}
      <path d="M21,11 Q20,6 18,5" fill="none" stroke="#1f2937" strokeWidth="1" strokeLinecap="round" />
      <path d="M27,11 Q28,6 30,5" fill="none" stroke="#1f2937" strokeWidth="1" strokeLinecap="round" />
      <circle cx="18" cy="5" r="1.5" fill="#1f2937" />
      <circle cx="30" cy="5" r="1.5" fill="#1f2937" />
      {/* Stinger */}
      <polygon points="22,38 24,42 26,38" fill="#1f2937" />
      {petted && <text x="34" y="8" fontSize="8" className="animate-float">❤️</text>}
      {status === 'idle' && <text x="34" y="10" fontSize="7" className="animate-pulse opacity-60">💤</text>}
    </svg>
  ),
  rabbit: (status, petted) => (
    <svg viewBox="0 0 48 48" className="w-full h-full">
      {/* Ears */}
      <ellipse cx="18" cy="10" rx="4" ry="10" fill="#e5e7eb" />
      <ellipse cx="30" cy="10" rx="4" ry="10" fill="#e5e7eb" />
      <ellipse cx="18" cy="10" rx="2.5" ry="7" fill="#fecaca" />
      <ellipse cx="30" cy="10" rx="2.5" ry="7" fill="#fecaca" />
      {/* Face */}
      <circle cx="24" cy="26" r="12" fill="#f3f4f6" />
      {/* Body */}
      <ellipse cx="24" cy="40" rx="8" ry="5" fill="#f3f4f6" />
      {/* Eyes */}
      {status === 'idle' ? (
        <>
          <path d="M19,24 Q21,26 23,24" fill="none" stroke="#1f2937" strokeWidth="1.5" />
          <path d="M25,24 Q27,26 29,24" fill="none" stroke="#1f2937" strokeWidth="1.5" />
        </>
      ) : (
        <>
          <circle cx="20" cy="24" r="2.5" fill="#ef4444" />
          <circle cx="28" cy="24" r="2.5" fill="#ef4444" />
          <circle cx="21" cy="23" r="1" fill="white" />
          <circle cx="29" cy="23" r="1" fill="white" />
        </>
      )}
      {/* Nose */}
      <ellipse cx="24" cy="28" rx="2" ry="1.5" fill="#fca5a5" />
      {/* Whiskers */}
      <line x1="14" y1="28" x2="20" y2="28" stroke="#d1d5db" strokeWidth="0.5" />
      <line x1="14" y1="30" x2="20" y2="30" stroke="#d1d5db" strokeWidth="0.5" />
      <line x1="28" y1="28" x2="34" y2="28" stroke="#d1d5db" strokeWidth="0.5" />
      <line x1="28" y1="30" x2="34" y2="30" stroke="#d1d5db" strokeWidth="0.5" />
      {petted && <text x="34" y="8" fontSize="8" className="animate-float">❤️</text>}
      {status === 'idle' && <text x="34" y="8" fontSize="7" className="animate-pulse opacity-60">💤</text>}
      {status === 'error' && <text x="34" y="8" fontSize="7">🥕</text>}
    </svg>
  ),
};

function getStatus(agent: any): PetStatus {
  if (agent.activeExecutions > 0) return 'working';
  return 'idle';
}

export function AgentPet({ agent, size = 48 }: { agent: any; size?: number }) {
  const [petted, setPetted] = useState(false);
  const petType = roleToPet[agent.role] || 'rabbit';
  const status = getStatus(agent);

  const handlePet = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPetted(true);
    setTimeout(() => setPetted(false), 1500);
  };

  return (
    <div
      className={cn(
        'relative cursor-pointer transition-transform hover:scale-110',
        status === 'working' && 'animate-bounce-gentle',
        status === 'offline' && 'opacity-40 grayscale'
      )}
      style={{ width: size, height: size }}
      onClick={handlePet}
      title="Click to pet!"
    >
      {petSvgs[petType](status, petted)}
    </div>
  );
}
