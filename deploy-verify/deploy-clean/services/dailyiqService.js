exports.getDailyBrief = async () => {
  return {
    success: true,
    date: new Date().toISOString().slice(0, 10),
    hitters: [],
    pitchers: [],
    prospectWatch: [],
    hobbyMovers: [],
    source: "mock"
  };
};
