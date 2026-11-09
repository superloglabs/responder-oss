// An isometric computer scanning logs, standing on a floor grid that fades
// into the page. The case is drawn as its outline, three flat faces, and
// gradient strips for the rounded edges. Screen details are drawn in each
// face's own coordinates through an affine transform. Motion lives in
// signal.css and stops when the user prefers reduced motion.
export function SignalComputerIllustration() {
  return (
    <svg className="signalComputer" width="306" height="225" viewBox="0 0 340 250" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="sfe-fr" x1="170.9" y1="214" x2="179.5" y2="214" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#f5f5f5"/><stop offset="0.2" stopColor="#f2f2f2"/><stop offset="0.5" stopColor="#efefef"/><stop offset="0.8" stopColor="#ededed"/><stop offset="1" stopColor="#ededed"/></linearGradient><linearGradient id="sfe-tf" x1="111.1" y1="59.5" x2="106.8" y2="67" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#fbfbfb"/><stop offset="0.2" stopColor="#fdfdfd"/><stop offset="0.5" stopColor="#fdfdfd"/><stop offset="0.8" stopColor="#fafafa"/><stop offset="1" stopColor="#f5f5f5"/></linearGradient><linearGradient id="sfe-tr" x1="175.2" y1="96.5" x2="179.5" y2="104" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#fbfbfb"/><stop offset="0.2" stopColor="#f8f8f8"/><stop offset="0.5" stopColor="#f3f3f3"/><stop offset="0.8" stopColor="#eeeeee"/><stop offset="1" stopColor="#ededed"/></linearGradient><linearGradient id="sfe-fb" x1="106.8" y1="177" x2="111.1" y2="179.5" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#f5f5f5"/><stop offset="1" stopColor="#ededed"/></linearGradient><linearGradient id="sfe-rb" x1="179.5" y1="214" x2="175.2" y2="216.5" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#ededed"/><stop offset="1" stopColor="#ededed"/></linearGradient>
        <radialGradient id="sfe-glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(170 148.5) scale(130 100)"><stop offset="0" stopColor="#f1f1f1"/><stop offset="1" stopColor="#f1f1f1" stopOpacity="0"/></radialGradient>
        <radialGradient id="sfe-gridfade" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(170 158.5) scale(150 105)"><stop offset="0" stopColor="#fff"/><stop offset=".45" stopColor="#fff" stopOpacity=".55"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></radialGradient>
        <mask id="sfe-gridmask" maskUnits="userSpaceOnUse" x="0" y="0" width="340" height="250"><rect width="340" height="250" fill="url(#sfe-gridfade)"/></mask>
        <linearGradient id="sfe-bezel" x1="0" y1="10" x2="0" y2="68" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#eeeeee"/><stop offset="1" stopColor="#f5f5f5"/></linearGradient>
        <linearGradient id="sfe-screen" x1="0" y1="15" x2="0" y2="63" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#ececec"/><stop offset="1" stopColor="#f2f2f2"/></linearGradient>
        <linearGradient id="sfe-beam" x1="0" y1="17" x2="0" y2="24" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#7d86ff" stopOpacity="0"/><stop offset="1" stopColor="#7d86ff" stopOpacity=".07"/></linearGradient>
        <linearGradient id="sfe-logfade" x1="0" y1="21" x2="0" y2="63" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#fff" stopOpacity="0"/><stop offset=".2" stopColor="#fff"/><stop offset=".8" stopColor="#fff"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></linearGradient>
        <mask id="sfe-logmask" maskUnits="userSpaceOnUse" x="14" y="21" width="56" height="42"><rect x="14" y="21" width="56" height="42" fill="url(#sfe-logfade)"/></mask>
        <clipPath id="sfe-screenclip"><rect x="14" y="15" width="56" height="48" rx="5"/></clipPath>
      </defs>
      <ellipse cx="170" cy="148.5" rx="130" ry="100" fill="url(#sfe-glow)"/>
      <path d="M-162.6 188.5L170 -3.5M-162.6 188.5L170 380.5M-152.2 194.5L180.4 2.5M-152.2 182.5L180.4 374.5M-141.8 200.5L190.8 8.5M-141.8 176.5L190.8 368.5M-131.4 206.5L201.2 14.5M-131.4 170.5L201.2 362.5M-121 212.5L211.6 20.5M-121 164.5L211.6 356.5M-110.6 218.5L222 26.5M-110.6 158.5L222 350.5M-100.2 224.5L232.4 32.5M-100.2 152.5L232.4 344.5M-89.8 230.5L242.7 38.5M-89.8 146.5L242.7 338.5M-79.4 236.5L253.1 44.5M-79.4 140.5L253.1 332.5M-69 242.5L263.5 50.5M-69 134.5L263.5 326.5M-58.6 248.5L273.9 56.5M-58.6 128.5L273.9 320.5M-48.2 254.5L284.3 62.5M-48.2 122.5L284.3 314.5M-37.8 260.5L294.7 68.5M-37.8 116.5L294.7 308.5M-27.5 266.5L305.1 74.5M-27.5 110.5L305.1 302.5M-17.1 272.5L315.5 80.5M-17.1 104.5L315.5 296.5M-6.7 278.5L325.9 86.5M-6.7 98.5L325.9 290.5M3.7 284.5L336.3 92.5M3.7 92.5L336.3 284.5M14.1 290.5L346.7 98.5M14.1 86.5L346.7 278.5M24.5 296.5L357.1 104.5M24.5 80.5L357.1 272.5M34.9 302.5L367.5 110.5M34.9 74.5L367.5 266.5M45.3 308.5L377.8 116.5M45.3 68.5L377.8 260.5M55.7 314.5L388.2 122.5M55.7 62.5L388.2 254.5M66.1 320.5L398.6 128.5M66.1 56.5L398.6 248.5M76.5 326.5L409 134.5M76.5 50.5L409 242.5M86.9 332.5L419.4 140.5M86.9 44.5L419.4 236.5M97.3 338.5L429.8 146.5M97.3 38.5L429.8 230.5M107.6 344.5L440.2 152.5M107.6 32.5L440.2 224.5M118 350.5L450.6 158.5M118 26.5L450.6 218.5M128.4 356.5L461 164.5M128.4 20.5L461 212.5M138.8 362.5L471.4 170.5M138.8 14.5L471.4 206.5M149.2 368.5L481.8 176.5M149.2 8.5L481.8 200.5M159.6 374.5L492.2 182.5M159.6 2.5L492.2 194.5M170 380.5L502.6 188.5M170 -3.5L502.6 188.5" stroke="#000" strokeOpacity=".1" strokeWidth=".6" mask="url(#sfe-gridmask)"/>
      <path d="M105.2 63.6L106 61.2L107.4 59.8L162.6 27.9L164 27.5L165.6 27.5L167 27.9L232.6 65.8L234 67.2L234.8 69.6L234.8 181.4L234 183.8L232.6 185.2L177.4 217.1L176 217.5L174.4 217.5L173 217.1L107.4 179.2L106 177.8L105.2 175.4Z" fill="#000" fillOpacity=".045" transform="translate(0 1.6)"/>
      <path d="M105.2 63.6L106 61.2L107.4 59.8L162.6 27.9L164 27.5L165.6 27.5L167 27.9L232.6 65.8L234 67.2L234.8 69.6L234.8 181.4L234 183.8L232.6 185.2L177.4 217.1L176 217.5L174.4 217.5L173 217.1L107.4 179.2L106 177.8L105.2 175.4Z" fill="#fff" transform="translate(0 -1)"/>
      <g>
        <path d="M112.5 174.6L112.9 173.4L113.6 172.7L162 144.7L162.7 144.5L163.5 144.5L164.2 144.7L164.9 145.2L226.4 180.7L227.1 181.4L227.5 182.6L227.5 190.5L227.1 191.7L226.4 192.3L178 220.3L177.3 220.5L176.5 220.5L175.8 220.3L175.1 219.8L113.6 184.3L112.9 183.7L112.5 182.5Z" fill="#ececec"/>
        <path d="M105.2 63.6L106 61.2L107.4 59.8L162.6 27.9L164 27.5L165.6 27.5L167 27.9L232.6 65.8L234 67.2L234.8 69.6L234.8 181.4L234 183.8L232.6 185.2L177.4 217.1L176 217.5L174.4 217.5L173 217.1L107.4 179.2L106 177.8L105.2 175.4Z" fill="#f5f5f5"/>
        <path d="M106.8 177L170.9 214L170.9 104L106.8 67Z" fill="#f5f5f5"/>
        <path d="M111.1 59.5L175.2 96.5L228.9 65.5L164.8 28.5Z" fill="#fbfbfb"/>
        <path d="M179.5 214L233.2 183L233.2 73L179.5 104Z" fill="#ededed"/>
        <path d="M170.9 214L179.5 214L179.5 104L170.9 104Z" fill="url(#sfe-fr)"/>
        <path d="M111.1 59.5L175.2 96.5L170.9 104L106.8 67Z" fill="url(#sfe-tf)"/>
        <path d="M175.2 96.5L228.9 65.5L233.2 73L179.5 104Z" fill="url(#sfe-tr)"/>
        <path d="M106.8 177L170.9 214L175.2 216.5L111.1 179.5Z" fill="url(#sfe-fb)"/>
        <path d="M179.5 214L233.2 183L228.9 185.5L175.2 216.5Z" fill="url(#sfe-rb)"/>
        <path d="M175.2 96.5L179.5 104L170.9 104Z" fill="#f7f7f7"/>
        <path d="M170.9 214L179.5 214L175.2 216.5Z" fill="#ededed"/>
      </g>
      <path d="M105.2 63.6L106 61.2L107.4 59.8L162.6 27.9L164 27.5L165.6 27.5L167 27.9L232.6 65.8L234 67.2L234.8 69.6L234.8 181.4L234 183.8L232.6 185.2L177.4 217.1L176 217.5L174.4 217.5L173 217.1L107.4 179.2L106 177.8L105.2 175.4Z" stroke="#000" strokeOpacity=".07" strokeWidth=".7" strokeLinejoin="round"/>
      <path d="M119.8 54.5L183.9 91.5M188.2 99L188.2 209" stroke="#ebebeb" strokeLinecap="round"/>
      <g transform="matrix(0.8660 0.5000 0.8660 -0.5000 102.45 59.51)" vectorEffect="non-scaling-stroke">
        <rect x="23" y="54" width="38" height="8" rx="4" fill="#f2f2f2"/>
        <path d="M27.5 54.5H56.5" stroke="#e6e6e6" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
        <path d="M24 28H60M24 32H60M24 36H60" stroke="#efefef" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      </g>
      <g transform="matrix(0.8660 -0.5000 0.0000 1.0000 175.20 101.51)">
        <path d="M36 14H62M36 18H62M36 22H62M36 26H62M36 30H62" stroke="#e4e4e4" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      </g>
      <g transform="matrix(0.8660 0.5000 0.0000 1.0000 102.45 59.51)">
        <rect x="8" y="9" width="68" height="60" rx="7" fill="url(#sfe-bezel)"/>
        <path d="M15 9.5H69" stroke="#e4e4e4" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
        <rect x="14" y="15" width="56" height="48" rx="5" fill="url(#sfe-screen)"/>
        <g clipPath="url(#sfe-screenclip)">
          <rect x="14" y="15" width="56" height="6" fill="#e6e6e6"/>
          <path d="M19 18h0M22.5 18h0" stroke="#d6d6d6" strokeWidth="2" strokeLinecap="round"/>
          <path d="M31 18h18" stroke="#d6d6d6" strokeWidth="1.3" strokeLinecap="round"/>
          <circle className="signalComputer__light" cx="64" cy="18" r="1.2" fill="#b9beff"/>
          <g mask="url(#sfe-logmask)">
            <g className="signalComputer__logs"><path d="M18 25h4M18 30h4M18 35h4M18 40h4M18 45h4M18 50h4M18 55h4M18 60h4M18 65h4M18 70h4M18 75h4M18 80h4M18 85h4M18 90h4M18 95h4M18 100h4M18 105h4M18 110h4M18 115h4M18 120h4M18 125h4M18 130h4M18 135h4M18 140h4" stroke="#e1e1e1" strokeWidth="1.6" strokeLinecap="round"/><path d="M25 25h0M25 30h0M25 35h0M25 40h0M25 45h0M25 50h0M25 55h0M25 60h0M25 65h0M25 70h0M25 75h0M25 80h0M25 85h0M25 90h0M25 95h0M25 100h0M25 105h0M25 110h0M25 115h0M25 120h0M25 125h0M25 130h0M25 135h0M25 140h0" stroke="#cfcfcf" strokeWidth="1.8" strokeLinecap="round"/><path d="M28 25h26M28 30h38M28 40h32M28 45h42M28 50h22M28 60h28M28 65h40M28 70h16M28 75h36M28 85h26M28 90h38M28 100h32M28 105h42M28 110h22M28 120h28M28 125h40M28 130h16M28 135h36" stroke="#d6d6d6" strokeWidth="1.6" strokeLinecap="round"/><path d="M28 35h18M28 55h34M28 80h26M28 95h18M28 115h34M28 140h26" stroke="#fafafa" strokeWidth="1.6" strokeLinecap="round"/></g>
          </g>
          <g className="signalComputer__scan">
            <rect x="14" y="17" width="56" height="7" fill="url(#sfe-beam)"/>
            <path d="M14 24h56" stroke="#a9afff" strokeOpacity=".55" strokeWidth=".7"/>
          </g>
        </g>
        <rect x="14" y="15" width="56" height="48" rx="5" stroke="#e0e0e0" strokeWidth=".8" vectorEffect="non-scaling-stroke"/>
        <rect x="42" y="86" width="28" height="3.4" rx="1.7" fill="#e4e4e4"/>
        <path d="M43 91.5H69" stroke="#fff" vectorEffect="non-scaling-stroke"/>
        <rect x="13" y="86" width="7" height="5" rx="1.5" fill="#f4f4f4" stroke="#e9e9e9" strokeWidth=".6" vectorEffect="non-scaling-stroke"/>
        <circle className="signalComputer__light" cx="16.5" cy="104" r="1.4" fill="#b9beff"/>
      </g>
    </svg>
  );
}
