export interface RunningGearSpan {
  readonly lengthLdu: number;
  readonly frontBogieLdu: number;
  readonly rearBogieLdu: number;
}

function ldu(value: number): string {
  return `${Number(value.toFixed(2))} LDU`;
}

export function runningGearSpanProblem(span: RunningGearSpan): string | null {
  const { lengthLdu, frontBogieLdu, rearBogieLdu } = span;
  if (![lengthLdu, frontBogieLdu, rearBogieLdu].every(Number.isFinite)) {
    return "the coupling faces and guides must be finite numbers";
  }
  if (!(lengthLdu > 0)) {
    return `the front coupling face must lie ahead of the rear one, but it is ${ldu(-lengthLdu)} behind it`;
  }
  if (frontBogieLdu < 0) {
    return `the front guide lies ${ldu(-frontBogieLdu)} ahead of the front coupling face, outside the vehicle`;
  }
  if (rearBogieLdu > lengthLdu) {
    return `the rear guide lies ${ldu(rearBogieLdu - lengthLdu)} behind the rear coupling face, outside the vehicle`;
  }
  if (frontBogieLdu > rearBogieLdu) {
    return `the front guide lies ${ldu(frontBogieLdu - rearBogieLdu)} behind the rear guide`;
  }
  return null;
}
