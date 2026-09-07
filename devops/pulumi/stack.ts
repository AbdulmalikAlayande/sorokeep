import { SorokeepDaemon } from "./index";

const daemon = new SorokeepDaemon("test-daemon", {
    amiId: "ami-1234567890abcdef0",
    network: "testnet",
    pollInterval: 300000,
});

export const instanceId = daemon.instanceId;
export const publicIp = daemon.publicIp;
