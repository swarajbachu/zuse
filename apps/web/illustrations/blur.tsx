import React from "react";

export const Blur = () => {
  return (
    <div className="absolute inset-0 pointer-events-none w-full h-full overflow-hidden">
      <div className="w-[488.15px] h-[502.50px] bg-white rounded-full blur-[215.36px] absolute -translate-x-full top-1/2 -translate-y-1/2 left-8" />
      <div className="w-[720.16px] h-293.75 bg-[#27251F] rounded-full blur-[287.15px] absolute left-0 top-0" />
      <div className="w-180 h-294 left-414 top-0 absolute bg-[#27251F] rounded-full blur-[278px]" />
    </div>
  );
};
