package demo;

public class App {
    private final ReportPort port;

    App(ReportPort port) {
        this.port = port;
    }

    String run(Report report) {
        return port.render(report);
    }

    String direct(ReportService service, Report report) {
        return service.render(report);
    }

    int start(Report report) {
        return report.countdown(3);
    }
}
